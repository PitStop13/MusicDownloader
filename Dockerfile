FROM python:3.11-slim

# Install system dependencies:
# - ffmpeg: audio extraction, MP3 encoding, and video/audio multiplexing
# - nodejs: JavaScript engine required by yt-dlp to solve video signatures without throttling
# - curl: container health check
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    nodejs \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY . .

# Environment configuration
ENV PYTHONUNBUFFERED=1
ENV DOWNLOADS_DIR=/app/downloads

# Create downloads storage directory
RUN mkdir -p /app/downloads

# Expose web interface port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8000/api/health || exit 1

# Start FastAPI server
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
