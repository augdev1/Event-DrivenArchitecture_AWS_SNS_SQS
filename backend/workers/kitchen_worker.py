import os
import json
import time
import boto3

AWS_REGION = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
AWS_ENDPOINT_URL = os.getenv("AWS_ENDPOINT_URL", "http://localhost:4566")

# Clientes Boto3 para SQS e DynamoDB
sqs = boto3.client(
    "sqs",
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
QUEUE_URL = f"{AWS_ENDPOINT_URL}/000000000000/kitchen-queue"


import datetime

def update_order_status(order_id: str, new_status: str):
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    orders_table.update_item(
        Key={"order_id": order_id},
        UpdateExpression="SET #s = :status, updated_at = :updated_at",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":status": new_status, ":updated_at": now_iso},
    )
    print(f"🔄 [STATUS ATUALIZADO] Pedido #{order_id} -> {new_status}")


def process_kitchen_queue():
    print(f"🍳 [COZINHA] Worker da Cozinha iniciado! Escutando fila SQS: {QUEUE_URL}...")

    while True:
        try:
            # Polling com Long Polling (WaitTimeSeconds=5 economiza requisições)
            response = sqs.receive_message(
                QueueUrl=QUEUE_URL,
                MaxNumberOfMessages=1,
                WaitTimeSeconds=5,
            )

            messages = response.get("Messages", [])

            for msg in messages:
                receipt_handle = msg["ReceiptHandle"]
                body_json = json.loads(msg["Body"])

                # Como a mensagem veio do SNS através do Fan-Out, o conteúdo real está dentro do campo 'Message'
                if "Message" in body_json:
                    order_data = json.loads(body_json["Message"])
                else:
                    order_data = body_json

                order_id = order_data["order_id"]
                customer = order_data.get("customer_name", "Cliente")
                items = order_data.get("items", [])

                print(f"\n🔔 [NOVO PEDIDO RECEBIDO] Pedido #{order_id} de {customer}")
                for item in items:
                    print(f"   👉 {item['quantity']}x {item['name']}")

                # 1. Muda status para PREPARANDO (Entrou na fila da cozinha física)
                update_order_status(order_id, "PREPARING")
                print(f"🍳 [COZINHA] Pedido #{order_id} entrou na esteira física da cozinha!")

                # 2. Remove a mensagem da fila SQS (confirmação de que a comanda foi recebida na cozinha)
                sqs.delete_message(
                    QueueUrl=QUEUE_URL,
                    ReceiptHandle=receipt_handle
                )
                print(f"🗑️ [SQS] Mensagem do pedido #{order_id} confirmada e deletada da fila.")
                print("⏳ [AGUARDANDO COZINHEIRO] O cozinheiro físico marcará como pronto via painel KDS.")

        except Exception as e:
            print(f"⚠️ Erro ao processar mensagem: {e}")
            time.sleep(2)


if __name__ == "__main__":
    process_kitchen_queue()
