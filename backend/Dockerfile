FROM python:3.11-slim

WORKDIR /app

# Instala dependências
COPY api/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copia o código da API e dos Workers
COPY . .

# Expõe a porta padrão da API
EXPOSE 8000

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
