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


import datetime

class UpdateStatusRequest(BaseModel):
    status: str
    reason: str | None = None


@app.post("/orders", status_code=201)
def create_order(request: CreateOrderRequest):
    """
    1. Cria o ID do pedido com timestamp ISO
    2. Grava no DynamoDB com status 'PENDING'
    3. Publica evento no AWS SNS (order-created)
    4. Retorna imediatamente para não travar o cliente
    """
    order_id = str(uuid.uuid4())[:8]
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()

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
        "created_at": now_iso,
        "updated_at": now_iso,
    }

    # 1. Salva o estado inicial no DynamoDB
    orders_table.put_item(Item=order_data)

    # 2. Prepara mensagem para o SNS (convertendo Decimal para float/str para JSON padrão)
    order_data_sns = {
        "order_id": order_id,
        "customer_name": request.customer_name,
        "items": [item.model_dump() for item in request.items],
        "total_amount": str(total_amount),
        "status": "PENDING",
        "created_at": now_iso
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
        "status": "PENDING",
        "created_at": now_iso
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
    Lista todos os pedidos salvos no DynamoDB e auto-purga itens corrompidos/sem itens
    """
    response = orders_table.scan()
    items = response.get("Items", [])
    valid_items = []

    for item in items:
        # Se for um item inválido (sem items ou lista vazia), exclui do DynamoDB
        if not item.get("order_id") or not item.get("items") or len(item.get("items")) == 0:
            try:
                orders_table.delete_item(Key={"order_id": item.get("order_id")})
            except Exception:
                pass
        else:
            valid_items.append(item)

    # Ordena pelos mais recentes primeiro
    valid_items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return valid_items


@app.patch("/orders/{order_id}/status")
def update_order_status_route(order_id: str, req: UpdateStatusRequest):
    """
    Regra de negócio: Atualiza o status do pedido para qualquer estágio válido
    (PENDING, PREPARING, READY, DISPATCHED, CANCELED)
    """
    valid_statuses = ["PENDING", "PREPARING", "READY", "DISPATCHED", "CANCELED"]
    new_status = req.status.upper()
    if new_status not in valid_statuses:
        raise HTTPException(
            status_code=400, 
            detail=f"Status inválido. Escolha entre: {', '.join(valid_statuses)}"
        )

    response = orders_table.get_item(Key={"order_id": order_id})
    if "Item" not in response:
        raise HTTPException(status_code=404, detail="Pedido não encontrado")

    current_order = response["Item"]
    current_status = current_order.get("status")

    # Regras de Negócio:
    # 1. Pedido já cancelado ou despachado não pode ser alterado arbitrariamente
    if current_status == "DISPATCHED" and new_status != "DISPATCHED":
        raise HTTPException(
            status_code=400, 
            detail="Pedido já despachado para entrega e não pode mais ser alterado na cozinha."
        )

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()

    update_expression = "SET #s = :status, updated_at = :updated_at"
    expr_names = {"#s": "status"}
    expr_values = {":status": new_status, ":updated_at": now_iso}

    if new_status == "CANCELED" and req.reason:
        update_expression += ", cancellation_reason = :reason"
        expr_values[":reason"] = req.reason

    orders_table.update_item(
        Key={"order_id": order_id},
        UpdateExpression=update_expression,
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )

    # Notifica via SNS
    event_payload = {
        "event": f"Order{new_status.capitalize()}",
        "order_id": order_id,
        "old_status": current_status,
        "new_status": new_status,
        "reason": req.reason,
        "updated_at": now_iso
    }
    sns_client.publish(
        TopicArn=TOPIC_ARN,
        Message=json.dumps(event_payload),
        Subject=f"Order{new_status.capitalize()}"
    )

    return {
        "message": f"Pedido #{order_id} atualizado para {new_status}!",
        "order_id": order_id,
        "status": new_status,
        "updated_at": now_iso
    }


@app.patch("/orders/{order_id}/ready")
def mark_order_ready(order_id: str):
    """
    Atalho rápido: Cozinheiro conclui o preparo (status -> READY)
    """
    return update_order_status_route(order_id, UpdateStatusRequest(status="READY"))


@app.delete("/orders/{order_id}")
def delete_order(order_id: str):
    """
    Deleta uma comanda/pedido do DynamoDB
    """
    response = orders_table.get_item(Key={"order_id": order_id})
    if "Item" not in response:
        raise HTTPException(status_code=404, detail="Pedido não encontrado")

    orders_table.delete_item(Key={"order_id": order_id})

    # Publica evento de deleção no SNS
    sns_client.publish(
        TopicArn=TOPIC_ARN,
        Message=json.dumps({"event": "OrderDeleted", "order_id": order_id}),
        Subject="OrderDeleted"
    )

    return {"message": f"Pedido #{order_id} deletado com sucesso!", "order_id": order_id}


@app.delete("/orders")
def clear_all_orders():
    """
    Limpa todas as comandas do DynamoDB (reset do ambiente de testes)
    """
    response = orders_table.scan()
    items = response.get("Items", [])
    deleted_count = 0

    for item in items:
        orders_table.delete_item(Key={"order_id": item["order_id"]})
        deleted_count += 1

    return {"message": f"Todos os {deleted_count} pedidos foram excluídos.", "count": deleted_count}

