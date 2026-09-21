FROM node:20-alpine AS frontend
WORKDIR /src
COPY plugins/nod-mic ./plugins/nod-mic
COPY plugins/nod-auth ./plugins/nod-auth
COPY web/package.json web/package-lock.json ./web/
WORKDIR /src/web
RUN npm ci
COPY web/ .
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
COPY config.json .
COPY --from=frontend /src/web/dist ./web/dist
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["sh", "-c", "uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
