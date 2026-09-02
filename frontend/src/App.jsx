import React, { useState, useEffect } from 'react';
import { 
  ShoppingBag, 
  Clock, 
  ChefHat, 
  Bike, 
  Radio, 
  RefreshCw, 
  Plus, 
  Minus, 
  Flame, 
  Check, 
  Smartphone, 
  Trash2, 
  Ban, 
  AlertTriangle, 
  Filter, 
  Send, 
  CheckCircle2, 
  X,
  RotateCcw
} from 'lucide-react';

const API_BASE_URL = `http://${window.location.hostname}:8008`;

const INITIAL_PRODUCTS = [
  {
    id: 1,
    name: 'American Salmon Sushi',
    category: 'Japonesa • 4.8 ★',
    price: 24.99,
    emoji: '🍣',
    quantity: 1,
  },
  {
    id: 2,
    name: 'Smash Burger Gourmet',
    category: 'Artesanal • 4.9 ★',
    price: 28.50,
    emoji: '🍔',
    quantity: 1,
  },
  {
    id: 3,
    name: 'Batata Rustica Trufada',
    category: 'Porção • 4.7 ★',
    price: 14.00,
    emoji: '🍟',
    quantity: 0,
  },
  {
    id: 4,
    name: 'Suco Natural de Laranja',
    category: 'Bebida 500ml',
    price: 8.00,
    emoji: '🥤',
    quantity: 0,
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('customer'); // 'customer' | 'kitchen'
  const [products, setProducts] = useState(INITIAL_PRODUCTS);
  const [customerName, setCustomerName] = useState('Gabriel');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activeOrder, setActiveOrder] = useState(null);
  const [allOrders, setAllOrders] = useState([]);
  const [kitchenFilter, setKitchenFilter] = useState('ALL'); // 'ALL' | 'PREPARING' | 'PENDING' | 'READY' | 'DISPATCHED' | 'CANCELED'
  const [telemetryLogs, setTelemetryLogs] = useState([]);

  // Modal de Cancelamento
  const [cancelModalOrder, setCancelModalOrder] = useState(null);
  const [cancelReason, setCancelReason] = useState('Falta de ingredientes na cozinha');

  // Modal de Recibo Digital Amazon S3 / AWS Lambda
  const [receiptModal, setReceiptModal] = useState(null);

  const handleViewReceipt = async (orderId) => {
    setReceiptModal({ order_id: orderId, loading: true, data: null });
    try {
      const res = await fetch(`${API_BASE_URL}/orders/${orderId}/receipt`);
      if (res.ok) {
        const data = await res.json();
        setReceiptModal({ order_id: orderId, loading: false, data });
      } else {
        setReceiptModal({ order_id: orderId, loading: false, error: 'Recibo ainda em processamento no S3' });
      }
    } catch (err) {
      setReceiptModal({ order_id: orderId, loading: false, error: 'Erro ao consultar recibo no Amazon S3' });
    }
  };

  // Cálculos de totais do carrinho
  const subtotal = products.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const deliveryFee = subtotal > 0 ? 5.00 : 0;
  const total = subtotal + deliveryFee;

  const handleQuantity = (id, delta) => {
    setProducts((prev) =>
      prev.map((item) => {
        if (item.id === id) {
          const newQty = Math.max(0, item.quantity + delta);
          return { ...item, quantity: newQty };
        }
        return item;
      })
    );
  };

  const addTelemetry = (msg, type) => {
    const time = new Date().toLocaleTimeString();
    setTelemetryLogs((prev) => [{ id: Math.random(), time, msg, type }, ...prev.slice(0, 6)]);
  };

  // 1. Criar Pedido (POST /orders)
  const handlePlaceOrder = async () => {
    const selectedItems = products.filter((p) => p.quantity > 0);
    if (selectedItems.length === 0) {
      alert('Selecione pelo menos um item para fazer o pedido!');
      return;
    }

    setLoading(true);

    try {
      const payload = {
        customer_name: customerName,
        items: selectedItems.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          price: item.price,
        })),
      };

      const response = await fetch(`${API_BASE_URL}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error('Falha ao criar pedido');
      }

      const data = await response.json();
      setActiveOrder({
        order_id: data.order_id,
        status: data.status,
        customer_name: customerName,
        items: selectedItems,
        total: total,
      });

      addTelemetry(`[API] Pedido #${data.order_id} gravado no DynamoDB como PENDING`, 'dynamo');
      addTelemetry(`[SNS] Publicado evento 'OrderCreated' no tópico order-created`, 'sns');
      addTelemetry(`[SQS] Fan-Out replicado para a fila kitchen-queue`, 'sqs');
      fetchOrdersList();
    } catch (err) {
      console.error('Erro ao fazer pedido:', err);
      alert('Erro ao conectar com a API. Verifique se o Docker está rodando!');
    } finally {
      setLoading(false);
    }
  };

  // 2. Buscar Lista de Pedidos (GET /orders) com feedback de refresh
  const fetchOrdersList = async (showFeedback = false) => {
    if (showFeedback) setRefreshing(true);
    try {
      const res = await fetch(`${API_BASE_URL}/orders`);
      if (res.ok) {
        const data = await res.json();
        setAllOrders(data);
      }
    } catch (e) {
      console.error('Erro ao listar pedidos:', e);
    } finally {
      if (showFeedback) {
        setTimeout(() => setRefreshing(false), 400);
      }
    }
  };

  // 3. Atualizar Status com Regras de Negócio (PATCH /orders/{id}/status)
  const handleUpdateStatus = async (orderId, newStatus, reason = null) => {
    // 1. Optimistic UI: atualiza a comanda imediatamente na lista da cozinha e no rastreador do cliente
    setAllOrders((prev) =>
      prev.map((o) => (o.order_id === orderId ? { ...o, status: newStatus } : o))
    );
    if (activeOrder && activeOrder.order_id === orderId) {
      setActiveOrder((prev) => ({ ...prev, status: newStatus }));
    }

    try {
      const payload = { status: newStatus };
      if (reason) payload.reason = reason;

      const res = await fetch(`${API_BASE_URL}/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json();
        alert(`Regra de Negócio: ${errData.detail || 'Não foi possível alterar o status'}`);
        fetchOrdersList();
        return;
      }

      addTelemetry(`[KDS] Pedido #${orderId} -> ${newStatus}${reason ? ` (${reason})` : ''}`, 'dynamo');
      addTelemetry(`[SNS] Evento 'Order${newStatus}' distribuído via Pub/Sub`, 'sns');
      fetchOrdersList();
      setCancelModalOrder(null);
    } catch (err) {
      console.error('Erro ao atualizar status:', err);
      fetchOrdersList();
    }
  };

  // 4. Deletar Comanda Única (DELETE /orders/{id}) - Remoção Instantânea
  const handleDeleteOrder = async (orderId) => {
    // 1. Remove imediatamente da tela (Optimistic UI)
    setAllOrders((prev) => prev.filter((o) => o.order_id !== orderId));
    if (activeOrder && activeOrder.order_id === orderId) {
      setActiveOrder(null);
    }

    try {
      const res = await fetch(`${API_BASE_URL}/orders/${orderId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        addTelemetry(`[DynamoDB] Comanda #${orderId} excluída do banco`, 'dynamo');
        addTelemetry(`[SNS] Notificado 'OrderDeleted' para os serviços`, 'sns');
      }
    } catch (err) {
      console.error('Erro ao deletar comanda:', err);
    }
  };

  // 5. Limpar Todos os Pedidos (DELETE /orders) - Reset Instantâneo
  const handleClearAllOrders = async () => {
    // Remove imediatamente tudo da tela
    setAllOrders([]);
    setActiveOrder(null);

    try {
      const res = await fetch(`${API_BASE_URL}/orders`, {
        method: 'DELETE',
      });

      if (res.ok) {
        addTelemetry('[DynamoDB] Todos os pedidos foram resetados', 'dynamo');
      }
    } catch (err) {
      console.error('Erro ao resetar pedidos:', err);
    }
  };

  // Polling automático contínuo
  useEffect(() => {
    fetchOrdersList();
    const interval = setInterval(async () => {
      fetchOrdersList();

      if (activeOrder && activeOrder.status !== 'DISPATCHED' && activeOrder.status !== 'CANCELED') {
        try {
          const res = await fetch(`${API_BASE_URL}/orders/${activeOrder.order_id}`);
          if (res.ok) {
            const data = await res.json();
            if (data.status !== activeOrder.status) {
              setActiveOrder((prev) => ({ ...prev, status: data.status }));
            }
          }
        } catch (e) {
          console.error(e);
        }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [activeOrder]);

  // Cálculo de tempo decorrido para KDS (minutos atrás)
  const getElapsedTime = (isoString) => {
    if (!isoString) return { text: 'Recente', level: 'normal' };
    const diffMs = new Date() - new Date(isoString);
    const mins = Math.floor(diffMs / 60000);
    const secs = Math.floor((diffMs % 60000) / 1000);

    if (mins < 5) return { text: `${mins}m ${secs}s`, level: 'normal' };
    if (mins < 12) return { text: `${mins}m (Atenção)`, level: 'warning' };
    return { text: `${mins}m (Atrasado!)`, level: 'late' };
  };

  // Filtra APENAS pedidos válidos (descarta fantasmas vazios sem itens)
  const validOrders = allOrders.filter(
    (o) => o && o.order_id && Array.isArray(o.items) && o.items.length > 0
  );

  const filteredOrders = validOrders.filter((o) => {
    if (kitchenFilter === 'ALL') return true;
    return o.status === kitchenFilter;
  });

  const countByStatus = (st) => validOrders.filter((o) => o.status === st).length;

  const getStepProgress = (status) => {
    if (status === 'PENDING') return '15%';
    if (status === 'PREPARING') return '55%';
    if (status === 'READY' || status === 'DISPATCHED') return '100%';
    return '0%';
  };

  return (
    <div className="app-container">
      {/* Top Header com Seletor de Visão */}
      <header className="app-header">
        <div className="header-brand-wrap">
          <div className="brand">
            <div className="brand-logo">iF</div>
            <div className="brand-info">
              <h1>iFood Cloud Delivery</h1>
              <p>
                <span>📍 Av. Paulista, 1000</span> • 
                <span style={{ color: 'var(--primary-cyan)', fontWeight: 600 }}> 25-35 min</span>
              </p>
            </div>
          </div>

          <div className="cloud-badge">
            <span className="pulse-dot"></span>
            <span className="cloud-badge-text-full">AWS LocalStack Conectado</span>
            <span className="cloud-badge-text-mobile">AWS Conectado</span>
          </div>
        </div>

        {/* Alternador de Visões: Cliente vs Cozinha */}
        <div className="nav-tabs-wrapper">
          <button
            className={`nav-tab-btn ${activeTab === 'customer' ? 'active' : ''}`}
            onClick={() => setActiveTab('customer')}
          >
            <Smartphone size={14} /> 
            <span className="tab-label-full">Visão Cliente</span>
            <span className="tab-label-short">Cliente</span>
          </button>

          <button
            className={`nav-tab-btn ${activeTab === 'kitchen' ? 'active' : ''}`}
            onClick={() => setActiveTab('kitchen')}
          >
            <ChefHat size={14} /> 
            <span className="tab-label-full">Visão Cozinha (KDS)</span>
            <span className="tab-label-short">Cozinha (KDS)</span>
            {countByStatus('PREPARING') > 0 && (
              <span className="tab-count-badge">
                {countByStatus('PREPARING')}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* ========================================================================= */}
      {/* VISÃO 1: CLIENTE (Cardápio e Order Tracker)                               */}
      {/* ========================================================================= */}
      {activeTab === 'customer' && (
        <div className="main-grid">
          {/* Coluna 1: Cardápio */}
          <div className="card-section">
            <div className="section-title">
              <span>Meu Cardápio</span>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                {products.filter((p) => p.quantity > 0).length} itens selecionados
              </span>
            </div>

            <div className="menu-list">
              {products.map((item) => (
                <div key={item.id} className="product-card">
                  <div className="product-left">
                    <div className="product-img">{item.emoji}</div>
                    <div className="product-details">
                      <h3>{item.name}</h3>
                      <p>{item.category}</p>
                      <div className="product-price">R$ {item.price.toFixed(2)}</div>
                    </div>
                  </div>

                  <div className="qty-controls">
                    <button 
                      className="qty-btn" 
                      onClick={() => handleQuantity(item.id, -1)}
                      disabled={item.quantity === 0}
                    >
                      <Minus size={14} />
                    </button>
                    <span className="qty-num">{item.quantity}</span>
                    <button 
                      className="qty-btn action-add" 
                      onClick={() => handleQuantity(item.id, 1)}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Rodapé fixo do cardápio com Valor Total permanente */}
            <div className="menu-total-footer">
              <div>
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Resumo do Cardápio
                </span>
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {products.reduce((acc, i) => acc + i.quantity, 0)} itens selecionados
                </p>
              </div>

              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  VALOR TOTAL:
                </span>
                <div className="total-value">
                  R$ {total.toFixed(2)}
                </div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  (com entrega inclusa)
                </span>
              </div>
            </div>
          </div>

          {/* Coluna 2: Checkout / Live Tracker */}
          <div className="checkout-panel">
            {activeOrder ? (
              <div className="tracker-container">
                <div className="tracker-header">
                  <div>
                    <h3 style={{ fontSize: '16px', fontWeight: 700 }}>Acompanhe seu Pedido</h3>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>ID: #{activeOrder.order_id}</p>
                  </div>
                  <span className={`tracker-badge badge-${activeOrder.status.toLowerCase()}`}>
                    {activeOrder.status === 'PENDING' && 'Recebido'}
                    {activeOrder.status === 'PREPARING' && 'Na Cozinha'}
                    {activeOrder.status === 'READY' && 'Pronto!'}
                    {activeOrder.status === 'DISPATCHED' && 'Saiu p/ Entrega'}
                    {activeOrder.status === 'CANCELED' && 'Cancelado'}
                  </span>
                </div>

                {/* Linha do Tempo (Stepper) */}
                <div className="timeline">
                  <div 
                    className="timeline-progress" 
                    style={{ width: getStepProgress(activeOrder.status) }}
                  ></div>

                  <div className={`timeline-step ${activeOrder.status ? 'completed' : ''}`}>
                    <div className="step-icon">
                      <Clock size={20} />
                    </div>
                    <span className="step-label">Recebido</span>
                  </div>

                  <div className={`timeline-step ${activeOrder.status === 'PREPARING' ? 'active' : (activeOrder.status === 'READY' || activeOrder.status === 'DISPATCHED') ? 'completed' : ''}`}>
                    <div className="step-icon">
                      <ChefHat size={20} />
                    </div>
                    <span className="step-label">Cozinha</span>
                  </div>

                  <div className={`timeline-step ${activeOrder.status === 'READY' || activeOrder.status === 'DISPATCHED' ? 'completed active' : ''}`}>
                    <div className="step-icon">
                      <Bike size={20} />
                    </div>
                    <span className="step-label">Pronto!</span>
                  </div>
                </div>

                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', background: 'var(--border-light)', padding: '12px', borderRadius: '12px' }}>
                  {activeOrder.status === 'PENDING' && '⏳ Aguardando worker da cozinha coletar a comanda na fila SQS...'}
                  {activeOrder.status === 'PREPARING' && (
                    <span>
                      👨‍🍳 <b>O cozinheiro está preparando seu lanche na chapa!</b>
                      <br />
                      <span style={{ color: 'var(--primary-cyan-dark)', fontSize: '12px' }}>
                        👉 Acesse a aba "Visão Cozinha (KDS)" para simular as ações do cozinheiro.
                      </span>
                    </span>
                  )}
                  {activeOrder.status === 'READY' && '🎉 Pedido finalizado pelo cozinheiro e pronto para ser entregue!'}
                  {activeOrder.status === 'DISPATCHED' && '🛵 Pedido despachado e a caminho da sua casa!'}
                  {activeOrder.status === 'CANCELED' && '❌ Este pedido foi cancelado pelo restaurante.'}
                </div>

                {/* Botão de Ver Recibo Fiscal Digital no Amazon S3 */}
                <button 
                  className="btn-secondary" 
                  style={{ marginTop: '12px', width: '100%', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                  onClick={() => handleViewReceipt(activeOrder.order_id)}
                >
                  🧾 Ver Recibo Fiscal Digital (Amazon S3 / AWS Lambda)
                </button>

                {(activeOrder.status === 'READY' || activeOrder.status === 'DISPATCHED' || activeOrder.status === 'CANCELED') && (
                  <button 
                    className="btn-primary" 
                    style={{ marginTop: '8px' }}
                    onClick={() => setActiveOrder(null)}
                  >
                    <RefreshCw size={16} /> Fazer Novo Pedido
                  </button>
                )}
              </div>
            ) : (
              <div className="card-section">
                <div className="section-title">Resumo do Pedido</div>

                <div style={{ marginBottom: '16px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    Nome do Cliente:
                  </label>
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: '10px',
                      border: '1px solid var(--border-color)',
                      marginTop: '6px',
                      fontSize: '14px',
                      fontWeight: 600
                    }}
                  />
                </div>

                <div className="summary-rows">
                  <div className="summary-row">
                    <span>Subtotal</span>
                    <span>R$ {subtotal.toFixed(2)}</span>
                  </div>
                  <div className="summary-row">
                    <span>Taxa de Entrega</span>
                    <span>R$ {deliveryFee.toFixed(2)}</span>
                  </div>
                  <div className="summary-row total">
                    <span>Total</span>
                    <span>R$ {total.toFixed(2)}</span>
                  </div>
                </div>

                <button
                  className="btn-primary"
                  onClick={handlePlaceOrder}
                  disabled={loading || subtotal === 0}
                >
                  <ShoppingBag size={18} />
                  {loading ? 'PUBLICANDO NO SNS...' : 'PLACE YOUR ORDER'}
                </button>
              </div>
            )}

            {/* Telemetria da Nuvem AWS */}
            <div className="telemetry-card">
              <div className="telemetry-title">
                <Radio size={14} /> Telemetria de Eventos AWS (LocalStack)
              </div>

              {telemetryLogs.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                  Aguardando primeiro evento de pedido...
                </div>
              ) : (
                telemetryLogs.map((log) => (
                  <div key={log.id} className="telemetry-item">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className={`tag-aws tag-${log.type}`}>{log.type.toUpperCase()}</span>
                      <span style={{ fontSize: '12px' }}>{log.msg}</span>
                    </div>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{log.time}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* VISÃO 2: COZINHA (KDS - Kitchen Display System com Gestão e Regras)      */}
      {/* ========================================================================= */}
      {activeTab === 'kitchen' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Barra Superior do KDS: Título + Botão Atualizar + Limpar */}
          <div className="kds-header">
            <div>
              <h2 style={{ fontSize: '20px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Flame color="#ED8936" /> Painel de Controle da Cozinha (KDS)
              </h2>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                Gerencie com precisão as comandas, status de preparo e fila de pedidos da <b>AWS LocalStack</b>.
              </p>
            </div>

            <div className="kds-actions-bar">
              {/* Botão de Atualizar Manual */}
              <button 
                className="btn-secondary"
                onClick={() => fetchOrdersList(true)}
                disabled={refreshing}
                title="Sincronizar com DynamoDB"
              >
                <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
                {refreshing ? 'Atualizando...' : 'Atualizar Cozinha'}
              </button>

              {/* Botão de Limpar Todas as Comandas */}
              {allOrders.length > 0 && (
                <button 
                  className="btn-danger-outline"
                  onClick={handleClearAllOrders}
                  title="Apagar todos os pedidos (Reset de Testes)"
                >
                  <Trash2 size={15} /> Limpar Histórico
                </button>
              )}
            </div>
          </div>

          {/* Barra de Filtros Dinâmicos de Status */}
          <div className="kds-filters">
            <button 
              className={`filter-pill ${kitchenFilter === 'ALL' ? 'active' : ''}`}
              onClick={() => setKitchenFilter('ALL')}
            >
              <Filter size={13} /> Todos <span className="filter-badge">{allOrders.length}</span>
            </button>

            <button 
              className={`filter-pill ${kitchenFilter === 'PREPARING' ? 'active' : ''}`}
              onClick={() => setKitchenFilter('PREPARING')}
            >
              <Flame size={13} color="#ED8936" /> Na Chapa (Preparo) <span className="filter-badge">{countByStatus('PREPARING')}</span>
            </button>

            <button 
              className={`filter-pill ${kitchenFilter === 'PENDING' ? 'active' : ''}`}
              onClick={() => setKitchenFilter('PENDING')}
            >
              <Clock size={13} color="#ECC94B" /> Na Fila (Pendentes) <span className="filter-badge">{countByStatus('PENDING')}</span>
            </button>

            <button 
              className={`filter-pill ${kitchenFilter === 'READY' ? 'active' : ''}`}
              onClick={() => setKitchenFilter('READY')}
            >
              <CheckCircle2 size={13} color="#38A169" /> Prontos <span className="filter-badge">{countByStatus('READY')}</span>
            </button>

            <button 
              className={`filter-pill ${kitchenFilter === 'DISPATCHED' ? 'active' : ''}`}
              onClick={() => setKitchenFilter('DISPATCHED')}
            >
              <Bike size={13} color="#3182CE" /> Despachados <span className="filter-badge">{countByStatus('DISPATCHED')}</span>
            </button>

            <button 
              className={`filter-pill ${kitchenFilter === 'CANCELED' ? 'active' : ''}`}
              onClick={() => setKitchenFilter('CANCELED')}
            >
              <Ban size={13} color="#E53E3E" /> Cancelados <span className="filter-badge">{countByStatus('CANCELED')}</span>
            </button>
          </div>

          {/* Grid de Comandas */}
          {filteredOrders.length === 0 ? (
            <div style={{ background: '#FFF', padding: '60px 20px', textAlign: 'center', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-light)' }}>
              <ChefHat size={48} color="var(--primary-cyan)" style={{ margin: '0 auto 12px' }} />
              <h3 style={{ fontSize: '18px', fontWeight: 700 }}>Nenhum pedido encontrado nesta categoria</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '6px' }}>
                Alterne o filtro acima ou faça novos pedidos na aba <b>"Visão Cliente"</b>.
              </p>
            </div>
          ) : (
            <div className="kds-grid">
              {filteredOrders.map((order) => {
                const timeInfo = getElapsedTime(order.created_at);

                return (
                  <div 
                    key={order.order_id} 
                    className={`kds-card border-${order.status.toLowerCase()}`}
                  >
                    <div>
                      {/* Topo do Card: ID, Cliente, Status e Cronômetro */}
                      <div className="kds-card-header">
                        <div>
                          <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
                            COMANDA #{order.order_id}
                          </span>
                          <h4 style={{ fontSize: '17px', fontWeight: 800, marginTop: '2px', color: 'var(--text-primary)' }}>
                            {order.customer_name}
                          </h4>
                          <span className={`timer-badge timer-${timeInfo.level}`}>
                            <Clock size={11} /> {timeInfo.text}
                          </span>
                        </div>

                        {/* Badge de Status */}
                        <span className={`tracker-badge badge-${order.status.toLowerCase()}`}>
                          {order.status === 'PREPARING' && 'NA CHAPA 🔥'}
                          {order.status === 'PENDING' && 'NA FILA ⏳'}
                          {order.status === 'READY' && 'PRONTO ✅'}
                          {order.status === 'DISPATCHED' && 'ENTREGUE 🛵'}
                          {order.status === 'CANCELED' && 'CANCELADO ❌'}
                        </span>
                      </div>

                      {/* Itens do Pedido */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
                        {order.items && order.items.map((it, idx) => (
                          <div 
                            key={idx} 
                            style={{ 
                              display: 'flex', 
                              justifyContent: 'space-between', 
                              alignItems: 'center', 
                              fontSize: '14px', 
                              fontWeight: 600, 
                              background: 'var(--bg-app)', 
                              padding: '8px 12px', 
                              borderRadius: '8px' 
                            }}
                          >
                            <span>👉 {it.quantity}x {it.name}</span>
                            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>R$ {Number(it.price).toFixed(2)}</span>
                          </div>
                        ))}
                      </div>

                      {/* Motivo de cancelamento se houver */}
                      {order.cancellation_reason && (
                        <div style={{ background: '#FFF5F5', border: '1px solid #FEB2B2', color: '#C53030', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', marginBottom: '10px' }}>
                          <b>Motivo:</b> {order.cancellation_reason}
                        </div>
                      )}
                    </div>

                    {/* Grupo de Ações da Cozinha com Regras de Negócio */}
                    <div className="kds-actions-group">
                      {/* Ação Primária dependendo do ciclo de vida */}
                      {order.status === 'PENDING' && (
                        <button
                          className="kds-btn-main kds-btn-start"
                          onClick={() => handleUpdateStatus(order.order_id, 'PREPARING')}
                        >
                          <Flame size={16} /> INICIAR PREPARO (NA CHAPA)
                        </button>
                      )}

                      {order.status === 'PREPARING' && (
                        <button
                          className="kds-btn-main kds-btn-ready"
                          onClick={() => handleUpdateStatus(order.order_id, 'READY')}
                        >
                          <Check size={16} /> CONCLUIR E MARCAR COMO PRONTO
                        </button>
                      )}

                      {order.status === 'READY' && (
                        <button
                          className="kds-btn-main kds-btn-dispatch"
                          onClick={() => handleUpdateStatus(order.order_id, 'DISPATCHED')}
                        >
                          <Bike size={16} /> DESPACHAR PARA O MOTOBOY
                        </button>
                      )}

                      {/* Linha de Ações Secundárias (Recibo S3, Cancelar & Deletar) */}
                      <div className="kds-row-actions">
                        <button
                          className="btn-secondary"
                          style={{ flex: 1, padding: '8px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                          onClick={() => handleViewReceipt(order.order_id)}
                          title="Ver Recibo Fiscal Digital no Amazon S3 (gerado pelo Lambda)"
                        >
                          🧾 Recibo S3
                        </button>

                        {order.status !== 'CANCELED' && order.status !== 'DISPATCHED' && (
                          <button
                            className="kds-btn-cancel"
                            onClick={() => setCancelModalOrder(order)}
                            title="Cancelar pedido com justificativa"
                          >
                            <Ban size={14} /> Cancelar
                          </button>
                        )}

                        <button
                          className="kds-btn-delete"
                          onClick={() => handleDeleteOrder(order.order_id)}
                          title="Excluir comanda permanentemente do DynamoDB"
                        >
                          <Trash2 size={14} /> Excluir
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Modal de Comprovante Fiscal Digital Amazon S3 / AWS Lambda */}
      {receiptModal && (
        <div className="modal-overlay" onClick={() => setReceiptModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '460px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
                🧾 Comprovante Digital (Amazon S3)
              </h3>
              <button 
                onClick={() => setReceiptModal(null)} 
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Armazenado em: <code>s3://ifood-order-receipts/receipts/{receiptModal.order_id}.json</code>
              <br />
              Gerado de forma serverless pela função <b>AWS Lambda</b> via <b>Amazon EventBridge</b>.
            </div>

            {receiptModal.loading ? (
              <div style={{ textAlign: 'center', padding: '24px' }}>
                <RefreshCw size={24} className="animate-spin" style={{ margin: '0 auto', display: 'block' }} />
                <p style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                  Consultando bucket S3 via API...
                </p>
              </div>
            ) : receiptModal.data ? (
              <div style={{
                background: 'var(--bg-app)',
                padding: '14px',
                borderRadius: '12px',
                border: '1px solid var(--border-light)',
                fontSize: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                maxHeight: '300px',
                overflowY: 'auto'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                  <span>{receiptModal.data.store}</span>
                  <span style={{ color: 'var(--primary-cyan-dark)' }}>{receiptModal.data.fiscal_receipt_id}</span>
                </div>
                <div><b>Consumidor:</b> {receiptModal.data.customer_name}</div>
                <div><b>Data/Hora Emissão:</b> {new Date(receiptModal.data.issued_at).toLocaleString('pt-BR')}</div>
                <hr style={{ border: 'none', borderTop: '1px dashed var(--border-color)' }} />
                <div><b>Itens do Pedido:</b></div>
                {receiptModal.data.items?.map((it, idx) => (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{it.quantity}x {it.name}</span>
                    <span>R$ {(Number(it.price) * Number(it.quantity)).toFixed(2)}</span>
                  </div>
                ))}
                <hr style={{ border: 'none', borderTop: '1px dashed var(--border-color)' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Taxa de Entrega</span>
                  <span>R$ {Number(receiptModal.data.delivery_fee || 5).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: '14px', color: 'var(--primary-cyan)' }}>
                  <span>TOTAL PAGO</span>
                  <span>R$ {Number(receiptModal.data.total_amount).toFixed(2)}</span>
                </div>
              </div>
            ) : (
              <p style={{ color: '#E53E3E', fontSize: '12px' }}>{receiptModal.error}</p>
            )}

            <button className="btn-primary" onClick={() => setReceiptModal(null)}>
              Fechar Recibo
            </button>
          </div>
        </div>
      )}

      {/* Modal de Cancelamento de Pedido com Regra de Negócio */}
      {cancelModalOrder && (
        <div className="modal-overlay" onClick={() => setCancelModalOrder(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 800, color: '#C53030', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={18} /> Cancelar Comanda #{cancelModalOrder.order_id}
              </h3>
              <button 
                onClick={() => setCancelModalOrder(null)} 
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
              >
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              Selecione o motivo operacional do cancelamento para registrar a justificativa no DynamoDB e notificar os canais da AWS:
            </p>

            <select
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              style={{
                width: '100%',
                padding: '10px',
                borderRadius: '8px',
                border: '1px solid var(--border-color)',
                fontSize: '13px',
                fontWeight: 600
              }}
            >
              <option value="Falta de ingredientes na cozinha">Falta de ingredientes na cozinha</option>
              <option value="Cozinha sobrecarregada / fila alta">Cozinha sobrecarregada / fila alta</option>
              <option value="Cancelamento solicitado pelo cliente">Cancelamento solicitado pelo cliente</option>
              <option value="Item esgotado no cardápio">Item esgotado no cardápio</option>
              <option value="Horário de fechamento da cozinha">Horário de fechamento da cozinha</option>
            </select>

            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <button
                style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: '#FFF', fontWeight: 600, cursor: 'pointer' }}
                onClick={() => setCancelModalOrder(null)}
              >
                Voltar
              </button>
              <button
                style={{ flex: 1, padding: '10px', borderRadius: '8px', border: 'none', background: '#E53E3E', color: '#FFF', fontWeight: 700, cursor: 'pointer' }}
                onClick={() => handleUpdateStatus(cancelModalOrder.order_id, 'CANCELED', cancelReason)}
              >
                Confirmar Cancelamento
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
