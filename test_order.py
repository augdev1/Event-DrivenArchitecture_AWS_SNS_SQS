import urllib.request
import json
import time

url = "http://localhost:8008/orders"
payload = {
    "customer_name": "Gabriel",
    "items": [
        {"name": "X-Bacon Especial", "quantity": 1, "price": 35.0},
        {"name": "Batata Rustica", "quantity": 1, "price": 15.0}
    ]
}

data = json.dumps(payload).encode("utf-8")
req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")

print("[1] Enviando pedido para a API (FastAPI)...")
with urllib.request.urlopen(req) as response:
    result = json.loads(response.read().decode("utf-8"))
    order_id = result["order_id"]
    print(f"SUCESSO: Pedido criado! ID: {order_id} | Status inicial: {result['status']}")

print("\n[2] Monitorando a mudanca de status no DynamoDB via Worker SQS...")
for i in range(7):
    time.sleep(1)
    status_url = f"http://localhost:8008/orders/{order_id}"
    with urllib.request.urlopen(status_url) as status_resp:
        order_info = json.loads(status_resp.read().decode("utf-8"))
        print(f"    Segundo {i+1}: Status atual do pedido = {order_info['status']}")
        if order_info['status'] == 'READY':
            print("\n>>> O PEDIDO FICOU PRONTO! Ciclo completo executado com sucesso! <<<")
            break
