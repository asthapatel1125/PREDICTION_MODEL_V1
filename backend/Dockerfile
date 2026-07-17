FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml ./
COPY backend/src ./backend/src
COPY config ./config
RUN pip install --no-cache-dir .
RUN useradd --create-home --uid 10001 axiom
USER axiom
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health')"
CMD ["sh","-c","uvicorn axiom.api.app:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
