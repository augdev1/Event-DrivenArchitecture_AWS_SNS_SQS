# Arquitetura Orientada a Eventos: Sistema de Delivery com AWS SNS, SQS, DynamoDB, EventBridge, Lambda e S3

Este projeto foi desenvolvido com foco no estudo prático e aprofundado de **Arquitetura Orientada a Eventos (Event-Driven Architecture - EDA)**, computação serverless e processamento assíncrono em nuvem. Como estudo de caso e referência de domínio, foi utilizado o fluxo de checkout e ciclo de vida de pedidos em grande escala característico de plataformas como o **iFood**.

Para viabilizar o desenvolvimento ágil, testes integrados de resiliência e eliminação de custos de nuvem sem comprometer a fidelidade do código, toda a infraestrutura da **AWS** é executada localmente através do **LocalStack** orquestrado via **Docker Compose**. O código-fonte consome o SDK oficial da Amazon (`boto3`), mantendo paridade absoluta com um ambiente de produção real.

---

## Arquitetura da Solução

![Arquitetura da Solução](arquitetura_aws.jpg)

### Visão Geral do Fluxo de Dados e Microsserviços

A solução adota o princípio de **desacoplamento temporal e de serviços**: a camada de ingestão HTTP não executa regras de negócio pesadas ou de longa duração, garantindo latência ultrabaixa (p99) e alta disponibilidade da API mesmo durante picos de demanda.

1. **Ingestão (Frontend React):** O cliente final seleciona os itens e submete o pedido via requisição REST assíncrona.
2. **API Gateway & Persistência Inicial (Python / FastAPI):**
   - Recebe o payload, valida a integridade dos dados e gera um identificador único (`order_id`).
   - Grava o estado inicial do pedido como `PENDING` no **AWS DynamoDB**.
   - Publica simultaneamente eventos de domínio no **Amazon EventBridge** e no **AWS SNS**.
   - Dispara de forma assíncrona a função **AWS Lambda** para geração de recibo e retorna resposta imediata (`201 Created`) ao cliente.
3. **Distribuição Fan-Out (AWS SNS):**
   - O tópico `order-created` replica instantaneamente o evento para os consumidores inscritos (como a fila de preparo da cozinha).
4. **Enfileiramento Persistente (AWS SQS):**
   - A fila `kitchen-queue` armazena as mensagens de forma durável, atuando como buffer contra picos de tráfego e garantindo entrega garantida (*At-Least-Once*).
5. **Processamento Assíncrono (Python Background Worker):**
   - O worker consome a fila via **Long Polling**, valida o tipo do evento, aplica regras de idempotência e atualiza a máquina de estados no DynamoDB para `PREPARING` ("Na Chapa").
   - A conclusão do preparo é realizada via intervenção manual pelo cozinheiro através do painel KDS.
6. **Roteamento Corporativo (Amazon EventBridge):**
   - O barramento `food-delivery-bus` centraliza os eventos de ciclo de vida (`OrderCreated`, `OrderReady`, `OrderDispatched`, `OrderCanceled`), permitindo filtragem declarativa de regras de negócio.
7. **Emissão Serverless de Comprovantes (AWS Lambda):**
   - A função `order-receipt-generator` é acionada assincronamente a cada novo pedido, calculando taxas, estruturando os metadados fiscais e persistindo o comprovante.
8. **Armazenamento de Objetos Imutável (Amazon S3):**
   - O bucket `ifood-order-receipts` armazena de forma permanente e auditável os recibos fiscais em formato JSON (`s3://ifood-order-receipts/receipts/{order_id}.json`), acessíveis diretamente via API e interface.
9. **Telemetria e Painel KDS em Tempo Real:**
   - O frontend sincroniza o estado via polling otimista e exibe a trilha de telemetria completa dos serviços AWS em tempo real.

---

<img width="1920" height="1080" alt="Interface do Sistema" src="https://github.com/user-attachments/assets/5c8d8edd-baf7-482a-84e1-8fbbc7bb2fbe" />

---

## Papel dos Serviços da AWS no Projeto

A arquitetura foi projetada explorando a especialização de cada serviço do ecossistema AWS:

| Serviço AWS | Componente | Papel Arquitetural e Justificativa Técnica |
| :--- | :--- | :--- |
| **AWS SNS** | Tópico `order-created` | **Mensageria Pub/Sub (1-para-N).** Desacopla a ingestão de pedidos dos serviços consumidores. Novos microsserviços podem se conectar ao tópico sem exigir mudanças na API. |
| **AWS SQS** | Fila `kitchen-queue` | **Buffer assíncrono e controle de concorrência.** Garante persistência e tolerância a falhas, absorvendo picos repentinos de demanda que excedam a capacidade de processamento imediato da cozinha. |
| **AWS DynamoDB** | Tabela `Orders` | **Banco de dados NoSQL Chave-Valor.** Proporciona latência estável em milissegundos de um dígito. Os valores monetários utilizam o tipo `Decimal` para evitar imprecisões de ponto flutuante. |
| **Amazon EventBridge** | Barramento `food-delivery-bus` | **Barramento corporativo de eventos.** Orquestra a coreografia de eventos do domínio entre serviços, permitindo roteamento granular e desacoplado através de regras baseadas em conteúdo (*content filtering*). |
| **AWS Lambda** | Função `order-receipt-generator` | **Computação Serverless.** Executa sob demanda sem servidor fixo, processando a emissão de comprovantes fiscais e desacoplando essa rotina do fluxo crítico de compra. |
| **Amazon S3** | Bucket `ifood-order-receipts` | **Armazenamento durável de objetos.** Atua como data lake e repositório definitivo para recibos, relatórios e notas fiscais gerados pelo Lambda. |
| **Boto3 (SDK AWS)** | Camada de Integração Python | SDK oficial utilizado pela API e pelos Workers para comunicação direta com a API da AWS, mantendo total compatibilidade entre LocalStack e ambientes gerenciados de nuvem. |

---

## Cenários Reais de Produção e Soluções Implementadas

Durante o ciclo de desenvolvimento e testes de carga da aplicação, nos deparamos com desafios comuns de sistemas distribuídos e de interfaces modernas, que foram mitigados com padrões de engenharia de software:

### 1. Resolução de Comandas Fantasmas e Inconsistência Eventual no DynamoDB
* **Cenário/Problema:** Registros gerados em testes iniciais com payloads vazios ou corrompidos geravam comandas sem itens visíveis no KDS, que reapareciam e dificultavam a exclusão.
* **Solução Técnica:**
  - Implementação de um mecanismo de **auto-purga ativa** no endpoint `GET /orders`: caso encontre qualquer registro orfão ou corrompido, o backend realiza a exclusão física imediata no DynamoDB antes de responder à chamada.
  - Implementação de filtro rigoroso de integridade no frontend (`validOrders`), impedindo a renderização de dados incompletos.
  - Adoção de **Optimistic UI** nas rotinas de remoção e limpeza geral de histórico, garantindo feedback visual instantâneo (0ms) sem travamentos por diálogos bloqueantes do navegador.

### 2. Idempotência e Prevenção de Regressão de Status no Worker SQS
* **Cenário/Problema:** Ao marcar uma comanda como `READY` ("Pronto") no KDS, a API publicava um evento no tópico SNS que, por causa do Fan-Out, era entregue na fila da cozinha. O worker da cozinha escutava a fila e, por não verificar o tipo do evento, regredia o pedido automaticamente de volta para `PREPARING` ("Na Chapa"), desfazendo a ação humana.
* **Solução Técnica:**
  - **Filtro de Mensageria:** O worker `kitchen_worker.py` passou a validar expressamente o campo `event`: apenas mensagens do tipo `OrderCreated` iniciam a esteira física; eventos posteriores (`OrderReady`, `OrderDispatched`, `OrderCanceled`) são confirmados e descartados do SQS sem reprocessamento.
  - **Trava de Estado (Idempotência):** Foi incluída verificação prévia no DynamoDB. Se o pedido já estiver em `PREPARING`, `READY`, `DISPATCHED` ou `CANCELED`, o worker aborta qualquer regressão, preservando a máquina de estados.
  - **Sincronização Reativa no Cliente:** O rastreador da tela do cliente agora reflete imediatamente as mudanças para `Pronto!` e `Saiu p/ Entrega` sem retrocessos.

### 3. Engenharia Frontend e Ergonomia Mobile vs. Desktop
* **Cenário/Problema:** A visualização em dispositivos móveis (como iPhone 14 Pro Max e iPhone SE) apresentava palavras cortadas no topo, botões de abas sobrepostos e espaços vazios nas bordas, além de permitir puxar a tela lateralmente com o dedo (*rubber-banding / horizontal drag*).
* **Solução Técnica:**
  - **Isolamento do Desktop:** O layout amplo original de computador foi mantido 100% inalterado.
  - **Mobile Stacking:** No mobile, o cabeçalho se reorganiza verticalmente em duas linhas limpas (`flex-direction: column !important`), com as abas de navegação divididas equilibradamente em 50%/50% da largura.
  - **Formatação Edge-to-Edge:** Eliminação das margens vazias externas do container no mobile, oferecendo a estética de um aplicativo nativo.
  - **Bloqueio de Rolagem Lateral:** Aplicação de `overflow-x: hidden !important;`, `overscroll-behavior-x: none !important;` e `touch-action: pan-y pinch-zoom;` no `html/body`, travando completamente qualquer deslizamento lateral indesejado e mantendo a rolagem estritamente vertical.

### 4. Escalabilidade com Amazon EventBridge, AWS Lambda e Amazon S3
* **Cenário/Problema:** A emissão de comprovantes e notas de pedidos não deve competir com a infraestrutura transacional do banco de dados operacional nem travar a resposta da requisição de checkout.
* **Solução Técnica:**
  - A API emite eventos de domínio no **Amazon EventBridge** (`food-delivery-bus`).
  - O EventBridge dispara a função serverless **AWS Lambda** (`order-receipt-generator`) de forma assíncrona.
  - O comprovante fiscal em formato JSON estruturado é gravado diretamente no **Amazon S3** (`ifood-order-receipts`), garantindo retenção imutável, baixo custo de armazenamento e alta durabilidade.
  - Um novo endpoint `GET /orders/{order_id}/receipt` e modais visuais na interface permitem a consulta e conferência instantânea dos comprovantes arquivados no S3.

---

## Tecnologias e Stack Utilizada

- **Linguagem Backend:** Python 3.11
- **Framework API:** FastAPI / Uvicorn (I/O assíncrono de alta performance)
- **Serviços AWS (LocalStack 3.4):**
  - **AWS SNS** (Pub/Sub Fan-Out)
  - **AWS SQS** (Fila e controle de concorrência)
  - **AWS DynamoDB** (NoSQL de baixa latência)
  - **Amazon EventBridge** (Barramento corporativo de eventos)
  - **AWS Lambda** (Computação serverless para faturamento)
  - **Amazon S3** (Armazenamento de recibos e comprovantes digitais)
- **Processamento Assíncrono:** Python Workers nativos com padrão Long Polling
- **Frontend:** React 18, Vite, Lucide Icons e Vanilla CSS responsivo com regras dedicadas para Desktop e Mobile
- **Containerização:** Docker e Docker Compose

---

## Como Executar Localmente

### Pré-requisitos
- Docker e Docker Compose instalados.
- Node.js (v18+) e Python (v3.10+) caso deseje rodar scripts auxiliares.

### 1. Clonar o Repositório
```bash
git clone https://github.com/augdev1/Event-DrivenArchitecture_AWS_SNS_SQS.git
cd Event-DrivenArchitecture_AWS_SNS_SQS
```

### 2. Subir a Infraestrutura Completa (LocalStack, API e Workers)
O comando abaixo inicia o LocalStack, provisiona automaticamente os tópicos SNS, filas SQS, tabelas DynamoDB, buckets S3, barramento EventBridge e funções Lambda:

```bash
docker compose up -d
```

Para verificar se os containers estão saudáveis:
```bash
docker ps
```

### 3. Iniciar a Interface do Usuário (Frontend)
Em outro terminal:

```bash
cd frontend
npm install
npm run dev
```

Acesse no navegador: `http://localhost:3001` (ou use o IP local da máquina na mesma rede Wi-Fi para testar no seu celular).

---

## Testes Automatizados e Validação do Fluxo

O projeto possui scripts para validação de ponta a ponta:

1. **Ciclo Completo de Pedido:**
```bash
python test_order.py
```

2. **Consulta do Recibo no Amazon S3 gerado pelo AWS Lambda:**
```bash
# Via API REST
curl http://localhost:8008/orders/<ORDER_ID>/receipt

# Diretamente via AWS CLI / LocalStack
docker exec localstack-aws awslocal s3 ls s3://ifood-order-receipts/receipts/
```

3. **Inspecionar Logs do Worker em Tempo Real:**
```bash
docker logs -f kitchen-worker
```

---

## Considerações sobre Produção

Para transição desta aplicação para a nuvem pública da AWS oficial:
1. **Infraestrutura como Código (IaC):** O script `init-aws.sh` é substituído por templates declarativos em **Terraform** ou **AWS CDK**.
2. **Computação e Microsserviços:** A API e o Worker de Cozinha podem ser orquestrados via **AWS ECS (Fargate)** ou **AWS EKS**. O gerador de comprovantes já está no padrão nativo do **AWS Lambda**.
3. **Segurança & IAM:** Configuração de IAM Roles com o princípio do menor privilégio (*Least Privilege*), eliminando chaves estáticas.
4. **Resiliência:** Adição de **Dead Letter Queues (DLQ)** com alarmes no **Amazon CloudWatch** para isolamento de mensagens venenosas (*poison pills*).
