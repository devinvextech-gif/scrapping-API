# Docker Setup Guide

## Overview
This application is a **Node.js Express server** with **Playwright-based web scraping** for extracting complaint data and processing PDFs. The Docker setup includes a multi-stage build for optimized image size and includes all necessary system dependencies for Playwright.

## Architecture

### Application
- **Framework**: Express.js
- **Port**: 3000
- **Type**: ES6 modules
- **Key Features**:
  - Browser automation via Playwright (Chromium)
  - PDF text extraction
  - File downloads management
  - RESTful API endpoints

### Docker Setup
- **Base Image**: Node.js 20 (Debian Bookworm)
- **Multi-stage Build**: Reduces final image size by ~500MB
- **Health Check**: Automated health verification every 30s
- **Non-root User**: Runs as `appuser` (UID 1000) for security
- **Volume**: Persistent storage for downloaded complaint files

## Building the Docker Image

### Option 1: Using docker-compose (Recommended)
```bash
docker-compose up -d
```

This builds and starts the container with:
- Port mapping: `3000:3000`
- Named volume for downloads persistence
- Health checks enabled
- Automatic restart policy

### Option 2: Manual Docker Build
```bash
# Build the image
docker build -t complaint-consumer:latest .

# Run the container
docker run -d \
  --name complaint-consumer \
  -p 3000:3000 \
  -v complaint-downloads:/app/downloads \
  --restart unless-stopped \
  complaint-consumer:latest
```

## Key Files

- **Dockerfile**: Multi-stage build (builder → runtime)
  - Stage 1: Installs all dependencies and Playwright browsers
  - Stage 2: Copies only necessary artifacts, optimized runtime

- **docker-compose.yml**: Development and production orchestration
  - Service definition with port and volume mappings
  - Health check configuration
  - Environment variables setup

- **.dockerignore**: Build context optimization
  - Excludes node_modules, .git, downloads, etc.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | production | Node environment |
| `PORT` | 3000 | Server port |

## API Endpoints

### Health Check
```
GET /
Response: 200 OK
```

### Extract Complaint Data
```
POST /extract
Body: JSON payload with complaint URL/credentials
Response: Extracted complaint data, messages, attachments
```

## Volumes

### complaint-downloads
- **Path**: `/app/downloads`
- **Purpose**: Stores extracted PDFs and attachments
- **Persistence**: Data survives container restarts

## System Dependencies

The Docker image includes all required Playwright runtime dependencies:
- GTK+ libraries (libgtk-3-0, etc.)
- Audio support (libasound2)
- X11 libraries (libxrandr2, libxcomposite1, etc.)
- Browser support libraries (libnss3, libnspr4, etc.)

## Health Check

The container includes a health check that:
- Runs every 30 seconds
- Has a 10-second timeout
- Waits 40 seconds before first check (startup period)
- Fails after 3 consecutive failures

Check status:
```bash
docker ps
# Look for "health" column
```

## Troubleshooting

### Container fails to start
```bash
# View logs
docker logs complaint-consumer

# Check resource usage
docker stats complaint-consumer
```

### Playwright timeout errors
- Ensure sufficient system resources (CPU, memory)
- Increase timeout values if targeting slow networks
- Check browser dependencies are installed: `docker run -it complaint-consumer:latest dpkg -l | grep lib`

### Downloads not persisting
```bash
# Verify volume is mounted
docker inspect complaint-consumer | grep -A 5 Mounts

# Manually check volume
docker volume inspect complaint-downloads
```

## Performance Optimization

### Multi-stage Build Benefits
- **Stage 1 (Builder)**: 1.5GB+ (all build tools and browsers)
- **Stage 2 (Runtime)**: ~800MB (only runtime artifacts)
- **Final Image**: ~850MB (includes Node.js, dependencies, Playwright)

### Memory Considerations
- Recommend: 1GB+ available RAM
- Playwright + Node.js typically uses 300-500MB
- Add buffer for concurrent requests

## Updating the Application

To deploy changes:
```bash
# Rebuild the image
docker-compose build

# Restart services
docker-compose down && docker-compose up -d

# Or use single command
docker-compose up -d --build
```

## Production Considerations

1. **Environment Variables**: Use `.env` file or orchestration platform (Kubernetes, Docker Swarm)
2. **Logging**: Consider using ELK stack or cloud logging services
3. **Monitoring**: Integrate with Prometheus/Grafana for metrics
4. **Backups**: Regularly backup the `complaint-downloads` volume
5. **Resource Limits**: Set memory and CPU limits in docker-compose or production orchestration
6. **Network**: Use private networks in docker-compose for isolation

## Example: Production Deployment with Resource Limits

```yaml
services:
  complaint-consumer:
    # ... existing config
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M
```

## Cleanup

```bash
# Stop and remove containers
docker-compose down

# Remove volume (data will be deleted)
docker volume rm complaint-downloads

# Remove image
docker rmi complaint-consumer:latest
```
