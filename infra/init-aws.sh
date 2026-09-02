#!/bin/bash
echo "=== [AWS LOCALSTACK] Inicializando infraestrutura AWS ==="

# 1. Configura a região padrão
export AWS_DEFAULT_REGION=us-east-1

# 2. Cria o Tópico SNS (onde a API vai 'anunciar' o pedido)
echo "Criando Tópico SNS: order-created..."
awslocal sns create-topic --name order-created

# 3. Cria a Fila SQS (onde o serviço de Cozinha vai 'consumir' o pedido)
echo "Criando Fila SQS: kitchen-queue..."
awslocal sqs create-queue --queue-name kitchen-queue

# 4. Conecta o SNS à fila SQS (Fan-Out)
# Pegamos o ARN (identificador único da AWS) de cada recurso:
TOPIC_ARN="arn:aws:sns:us-east-1:000000000000:order-created"
QUEUE_ARN="arn:aws:sqs:us-east-1:000000000000:kitchen-queue"

echo "Conectando SNS -> SQS..."
awslocal sns subscribe \
    --topic-arn "$TOPIC_ARN" \
    --protocol sqs \
    --notification-endpoint "$QUEUE_ARN"

# 5. Cria uma tabela no DynamoDB para salvar o status dos pedidos
echo "Criando Tabela DynamoDB: Orders..."
awslocal dynamodb create-table \
    --table-name Orders \
    --attribute-definitions AttributeName=order_id,AttributeType=S \
    --key-schema AttributeName=order_id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST

echo "=== [AWS LOCALSTACK] Recursos criados com sucesso! ==="
