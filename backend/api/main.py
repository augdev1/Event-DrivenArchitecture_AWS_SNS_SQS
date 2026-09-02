import os
import uuid
import json
from decimal import Decimal
import boto3
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List

app = FastAPI(title="iFood Order Service (AWS Demo)")

# Permite que o Frontend React faça requisições
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuração da AWS (Aponta para o LocalStack se estiver em desenvolvimento)
AWS_REGION = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
AWS_ENDPOINT_URL = os.getenv("AWS_ENDPOINT_URL", "http://localhost:4566")

# Clientes Boto3 para SNS e DynamoDB
sns_client = boto3.client(
    "sns",
    region_name=AWS_REGION,
    endpoint_url=AWS_ENDPOINT_URL,
    aws_access_key_id="test",
    aws_secret_access_key="test",
)

dynamodb = boto3.resource(
    "dynamodb",
    region_name=AWS_REGION,
    endpoint_url=AWS_ENDPOINT_URL,
    aws_access_key_id="test",
    aws_secret_access_key="test",
)

orders_table = dynamodb.Table("Orders")
TOPIC_ARN = f"arn:aws:sns:{AWS_REGION}:000000000000:order-created"


# Modelos Pydantic (Validação de Dados)
class OrderItem(BaseModel):
    name: str
    quantity: int
    price: float


class CreateOrderRequest(BaseModel):
    customer_name: str
    items: List[OrderItem]


@app.get("/")
def health_check():
    return {"status": "ok", "service": "iFood Order API", "aws_endpoint": AWS_ENDPOINT_URL}


@app.post("/orders", status_code=201)
def create_order(request: CreateOrderRequest):
    """
    1. Cria o ID do pedido
    2. Grava no DynamoDB com status 'PENDING'
    3. Publica evento no AWS SNS (order-created)
    4. Retorna imediatamente para não travar o cliente
    """
    order_id = str(uuid.uuid4())[:8]

    # Converte floats para Decimal para compatibilidade com DynamoDB
    items_dynamo = [
        {
            "name": item.name,
            "quantity": item.quantity,
            "price": Decimal(str(item.price))
        }
        for item in request.items
    ]

    total_amount = sum(Decimal(str(item.price)) * item.quantity for item in request.items)

    order_data = {
        "order_id": order_id,
        "customer_name": request.customer_name,
        "items": items_dynamo,
        "total_amount": total_amount,
        "status": "PENDING",  # Status inicial
    }

    # 1. Salva o estado inicial no DynamoDB
    orders_table.put_item(Item=order_data)

    # 2. Prepara mensagem para o SNS (convertendo Decimal para float/str para JSON padrão)
    order_data_sns = {
        "order_id": order_id,
        "customer_name": request.customer_name,
        "items": [item.model_dump() for item in request.items],
        "total_amount": str(total_amount),
        "status": "PENDING"
    }

    # Publica o evento no AWS SNS (Fan-out para as filas SQS)
    sns_client.publish(
        TopicArn=TOPIC_ARN,
        Message=json.dumps(order_data_sns),
        Subject="OrderCreated"
    )

    return {
        "message": "Pedido recebido com sucesso!",
        "order_id": order_id,
        "status": "PENDING"
    }


@app.get("/orders/{order_id}")
def get_order(order_id: str):
    """
    Consulta o status do pedido no DynamoDB
    """
    response = orders_table.get_item(Key={"order_id": order_id})
    if "Item" not in response:
        raise HTTPException(status_code=404, detail="Pedido não encontrado")
    return response["Item"]


@app.get("/orders")
def list_orders():
    """
    Lista todos os pedidos salvos no DynamoDB
    """
    response = orders_table.scan()
    return response.get("Items", [])
