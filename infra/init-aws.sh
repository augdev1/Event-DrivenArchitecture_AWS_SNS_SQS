#!/bin/bash
echo "=== [AWS LOCALSTACK] Inicializando infraestrutura completa AWS (SNS, SQS, DynamoDB, S3, EventBridge, Lambda) ==="

# 1. Configura a região padrão
export AWS_DEFAULT_REGION=us-east-1

# 2. Cria o Tópico SNS (onde a API vai 'anunciar' o pedido para microsserviços)
echo "1/6. Criando Tópico SNS: order-created..."
awslocal sns create-topic --name order-created

# 3. Cria a Fila SQS (onde o serviço de Cozinha vai 'consumir' o pedido)
echo "2/6. Criando Fila SQS: kitchen-queue..."
awslocal sqs create-queue --queue-name kitchen-queue

# 4. Conecta o SNS à fila SQS (Fan-Out)
TOPIC_ARN="arn:aws:sns:us-east-1:000000000000:order-created"
QUEUE_ARN="arn:aws:sqs:us-east-1:000000000000:kitchen-queue"

echo "Conectando SNS -> SQS (Fan-Out Subscription)..."
awslocal sns subscribe \
    --topic-arn "$TOPIC_ARN" \
    --protocol sqs \
    --notification-endpoint "$QUEUE_ARN"

# 5. Cria Tabela DynamoDB para persistência de estado dos pedidos
echo "3/6. Criando Tabela DynamoDB: Orders..."
awslocal dynamodb create-table \
    --table-name Orders \
    --attribute-definitions AttributeName=order_id,AttributeType=S \
    --key-schema AttributeName=order_id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST

# 6. Cria Bucket Amazon S3 para Comprovantes Fiscais e Recibos Digitais
echo "4/6. Criando Bucket Amazon S3: ifood-order-receipts..."
awslocal s3 mb s3://ifood-order-receipts

# 7. Cria Barramento Corporativo Amazon EventBridge
echo "5/6. Criando Barramento Amazon EventBridge: food-delivery-bus..."
awslocal events create-event-bus --name food-delivery-bus

# 8. Cria e Registra Função Serverless AWS Lambda: order-receipt-generator
echo "6/6. Registrando Função AWS Lambda: order-receipt-generator..."
if [ -f /app/lambdas/receipt_generator.py ]; then
    cd /tmp && zip -q receipt_generator.zip -j /app/lambdas/receipt_generator.py
    awslocal lambda create-function \
        --function-name order-receipt-generator \
        --runtime python3.10 \
        --role arn:aws:iam::000000000000:role/lambda-role \
        --handler receipt_generator.lambda_handler \
        --zip-file fileb:///tmp/receipt_generator.zip
    echo "Lambda order-receipt-generator registrado com sucesso!"
fi

echo "=== [AWS LOCALSTACK] Toda a infraestrutura AWS foi provisionada com sucesso! ==="
