import json
import os
import boto3
import datetime

AWS_REGION = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
AWS_ENDPOINT_URL = os.getenv("AWS_ENDPOINT_URL", "http://localhost:4566")

s3_client = boto3.client(
    "s3",
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
BUCKET_NAME = "ifood-order-receipts"

def lambda_handler(event, context):
    """
    AWS Lambda: Gerador de Comprovante Fiscal / Recibo Digital (S3 + EventBridge)
    Disparado via Amazon EventBridge quando um pedido é criado ('OrderCreated') ou finalizado.
    """
    print("🚀 [LAMBDA - RECEIPT GENERATOR] Evento recebido via EventBridge:", json.dumps(event))

    # O payload pode vir direto do EventBridge (detail) ou SNS/SQS
    detail = event.get("detail", event)
    order_id = detail.get("order_id")
    customer = detail.get("customer_name", "Consumidor")
    items = detail.get("items", [])
    total = detail.get("total", 0.0)
    created_at = detail.get("created_at", datetime.datetime.now(datetime.timezone.utc).isoformat())

    if not order_id:
        return {"statusCode": 400, "body": "order_id ausente no evento"}

    # Monta comprovante estruturado
    receipt_data = {
        "fiscal_receipt_id": f"REC-{order_id.upper()}",
        "order_id": order_id,
        "store": "iFood Cloud Gourmet Delivery",
        "customer_name": customer,
        "items": items,
        "subtotal": round(total - 5.0, 2) if total > 5.0 else total,
        "delivery_fee": 5.00,
        "total_amount": float(total),
        "issued_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "created_at": created_at,
        "status": "ISSUED",
        "storage_class": "STANDARD_S3"
    }

    s3_key = f"receipts/{order_id}.json"

    # Salva no Amazon S3
    s3_client.put_object(
        Bucket=BUCKET_NAME,
        Key=s3_key,
        Body=json.dumps(receipt_data, indent=2),
        ContentType="application/json",
        Metadata={
            "order_id": order_id,
            "customer": customer
        }
    )

    s3_uri = f"s3://{BUCKET_NAME}/{s3_key}"
    print(f"✅ [S3] Comprovante digital arquivado com sucesso no S3: {s3_uri}")

    # Atualiza o pedido no DynamoDB com o link do comprovante gerado pelo Lambda
    try:
        orders_table.update_item(
            Key={"order_id": order_id},
            UpdateExpression="SET receipt_url = :url, s3_key = :key",
            ExpressionAttributeValues={
                ":url": s3_uri,
                ":key": s3_key
            }
        )
        print(f"📑 [DynamoDB] Pedido #{order_id} enriquecido com receipt_url.")
    except Exception as e:
        print(f"Aviso ao vincular recibo no DynamoDB: {e}")

    return {
        "statusCode": 200,
        "receipt_id": receipt_data["fiscal_receipt_id"],
        "s3_uri": s3_uri
    }
