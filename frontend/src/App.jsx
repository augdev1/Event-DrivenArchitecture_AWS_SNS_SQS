import React, { useState, useEffect } from 'react';
import { 
  ShoppingBag, 
  Utensils, 
  CheckCircle2, 
  Clock, 
  ChefHat, 
  Bike, 
  Server, 
  Radio, 
  Layers, 
  Database,
  RefreshCw,
  Plus,
  Minus
} from 'lucide-react';

// Permite que tanto o PC quanto celulares na mesma rede Wi-Fi acessem a API
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
  const [products, setProducts] = useState(INITIAL_PRODUCTS);
  const [customerName, setCustomerName] = useState('Gabriel');
  const [loading, setLoading] = useState(false);
  const [activeOrder, setActiveOrder] = useState(null);
  const [telemetryLogs, setTelemetryLogs] = useState([]);

  // Atualiza quantidade
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

  // Cálculos de totais
  const subtotal = products.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const deliveryFee = subtotal > 0 ? 5.00 : 0;
  const total = subtotal + deliveryFee;

  // Enviar Pedido (POST /orders)
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
    } catch (err) {
      console.error('Erro ao fazer pedido:', err);
      alert('Erro ao conectar com a API. Verifique se o Docker está rodando!');
    } finally {
      setLoading(false);
    }
  };

  const addTelemetry = (msg, type) => {
    const time = new Date().toLocaleTimeString();
    setTelemetryLogs((prev) => [{ id: Math.random(), time, msg, type }, ...prev.slice(0, 5)]);
  };

  // Polling em tempo real do status do pedido ativo
  useEffect(() => {
    if (!activeOrder || activeOrder.status === 'READY') return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/orders/${activeOrder.order_id}`);
        if (res.ok) {
          const data = await res.json();
          if (data.status !== activeOrder.status) {
            setActiveOrder((prev) => ({ ...prev, status: data.status }));

            if (data.status === 'PREPARING') {
              addTelemetry(`[Worker] SQS consumido! Cozinha preparando #${activeOrder.order_id}`, 'sqs');
            } else if (data.status === 'READY') {
              addTelemetry(`[DynamoDB] Status atualizado para READY! Mensagem deletada do SQS`, 'dynamo');
            }
          }
        }
      } catch (e) {
        console.error('Erro ao consultar status:', e);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [activeOrder]);

  // Progresso do Stepper
  const getStepProgress = (status) => {
    if (status === 'PENDING') return '15%';
    if (status === 'PREPARING') return '55%';
    if (status === 'READY') return '100%';
    return '0%';
  };

  return (
    <div className="app-container">
      {/* Top Header */}
      <header className="app-header">
        <div className="brand">
          <div className="brand-logo">iF</div>
          <div className="brand-info">
            <h1>iFood Cloud Delivery</h1>
            <p>
              <span>📍 Av. Paulista, 1000</span> • 
              <span style={{ color: 'var(--primary-cyan)', fontWeight: 600 }}> Entrega em 25-35 min</span>
            </p>
          </div>
        </div>

        <div className="cloud-badge">
          <span className="pulse-dot"></span>
          <span>AWS LocalStack Conectado</span>
        </div>
      </header>

      {/* Grid Principal */}
      <div className="main-grid">
        {/* Coluna 1: Cardápio / Itens */}
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

          {/* Rodapé fixo do cardápio com Valor Total sempre visível */}
          <div style={{
            marginTop: '20px',
            paddingTop: '16px',
            borderTop: '2px dashed var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-card-hover)',
            padding: '14px 18px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-light)'
          }}>
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
              <div style={{
                fontSize: '22px',
                fontWeight: 800,
                color: 'var(--primary-cyan)',
                lineHeight: '1.2'
              }}>
                R$ {total.toFixed(2)}
              </div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                (com entrega inclusa)
              </span>
            </div>
          </div>
        </div>

        {/* Coluna 2: Checkout & Live Order Tracker */}
        <div className="checkout-panel">
          {/* Se houver pedido ativo, mostra o Tracker */}
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
                </span>
              </div>

              {/* Linha do Tempo (Stepper) */}
              <div className="timeline">
                <div 
                  className="timeline-progress" 
                  style={{ width: getStepProgress(activeOrder.status) }}
                ></div>

                {/* Passo 1: Recebido */}
                <div className={`timeline-step ${activeOrder.status ? 'completed' : ''}`}>
                  <div className="step-icon">
                    <Clock size={20} />
                  </div>
                  <span className="step-label">Recebido</span>
                </div>

                {/* Passo 2: Cozinha */}
                <div className={`timeline-step ${activeOrder.status === 'PREPARING' ? 'active' : activeOrder.status === 'READY' ? 'completed' : ''}`}>
                  <div className="step-icon">
                    <ChefHat size={20} />
                  </div>
                  <span className="step-label">Cozinha</span>
                </div>

                {/* Passo 3: Pronto */}
                <div className={`timeline-step ${activeOrder.status === 'READY' ? 'completed active' : ''}`}>
                  <div className="step-icon">
                    <Bike size={20} />
                  </div>
                  <span className="step-label">Pronto!</span>
                </div>
              </div>

              <div style={{ fontSize: '13px', color: 'var(--text-secondary)', background: 'var(--border-light)', padding: '12px', borderRadius: '12px' }}>
                {activeOrder.status === 'PENDING' && '⏳ Aguardando worker da cozinha coletar a comanda na fila SQS...'}
                {activeOrder.status === 'PREPARING' && '🍳 Cozinheiro processando o pedido na chapa (Worker ativo)...'}
                {activeOrder.status === 'READY' && '🎉 Pedido finalizado com sucesso e pronto para ser entregue!'}
              </div>

              {activeOrder.status === 'READY' && (
                <button 
                  className="btn-primary" 
                  style={{ marginTop: '10px' }}
                  onClick={() => setActiveOrder(null)}
                >
                  <RefreshCw size={16} /> Fazer Novo Pedido
                </button>
              )}
            </div>
          ) : (
            /* Resumo do Carrinho */
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

          {/* Telemetria da Nuvem AWS (Para demonstrar ao recrutador) */}
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
    </div>
  );
}
