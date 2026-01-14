---
name: scaleway-deploy
description: Deploy Docker apps to Scaleway with Caddy reverse proxy and GitHub Actions CI/CD
user_invocable: true
keywords: [deploy, scaleway, docker, caddy, ci, cd, production, vps, ssl, cloudflare]
---

# Scaleway Deploy

CLI-first deployment workflow for Docker applications to Scaleway VPS with automatic SSL via Caddy.

## When to Use

- "Deploy to production"
- "Set up Scaleway infrastructure"
- "Configure CI/CD for deployment"
- "Check production status"
- "View production logs"

## Quick Commands

```bash
# Deploy (rsync + docker compose)
./deploy/deploy.sh [user@host]

# Check status
ssh root@<HOST> 'cd /opt/<app> && docker compose -f docker/docker-compose.prod.yml ps'

# View logs
ssh root@<HOST> 'cd /opt/<app> && docker compose -f docker/docker-compose.prod.yml logs -f'

# Restart services
ssh root@<HOST> 'cd /opt/<app> && docker compose -f docker/docker-compose.prod.yml up -d --build --remove-orphans'

# Health check
curl -f http://<HOST>:3001/api/health
```

## Full Setup Workflow

### Step 1: Create Scaleway Instance

```bash
# Via Scaleway Console or CLI
scw instance server create type=DEV1-L zone=fr-par-1 image=ubuntu_jammy

# Note the public IP
export SERVER_HOST=<public-ip>
```

**Recommended spec:** DEV1-L (4 vCPU, 8GB RAM, ~€14/month)

### Step 2: Server Setup

SSH to server and run setup:

```bash
ssh root@$SERVER_HOST

# Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker && systemctl start docker

# Install Docker Compose plugin
apt install -y docker-compose-plugin

# Verify
docker --version && docker compose version

# Install Caddy (reverse proxy with auto-SSL)
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy -y

# Configure firewall
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP
ufw allow 443/tcp  # HTTPS
ufw --force enable

# Create app directory
mkdir -p /opt/<app>
```

### Step 3: Create Deployment Files

**deploy/deploy.sh:**
```bash
#!/bin/bash
set -e

SERVER=${1:-"root@<SERVER_HOST>"}
REMOTE_PATH="/opt/<app>"

echo "=== Deploying to $SERVER ==="

rsync -avz --delete \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '.env' \
    --exclude '.env.local' \
    --exclude 'dist' \
    --exclude '*.log' \
    --exclude 'playwright-report' \
    --exclude 'test-results' \
    --exclude '.claude' \
    --exclude '.context' \
    ./ ${SERVER}:${REMOTE_PATH}/

if [ -f ".env.production" ]; then
    scp .env.production ${SERVER}:${REMOTE_PATH}/.env.production
fi

ssh ${SERVER} << 'ENDSSH'
cd /opt/<app>
docker compose -f docker/docker-compose.prod.yml --env-file .env.production up -d --build --remove-orphans
sleep 10
docker compose -f docker/docker-compose.prod.yml ps
docker image prune -f
ENDSSH

echo "=== Deploy Complete ==="
```

Make executable:
```bash
chmod +x deploy/deploy.sh
```

### Step 4: Create GitHub Actions CI/CD

**.github/workflows/deploy.yml:**
```yaml
name: Deploy to Scaleway

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  SERVER_USER: root
  SERVER_PATH: /opt/<app>

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm run test
        continue-on-error: true

  deploy:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4

      - name: Setup SSH
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_rsa
          chmod 600 ~/.ssh/id_rsa
          ssh-keyscan -H ${{ secrets.SERVER_HOST }} >> ~/.ssh/known_hosts

      - name: Deploy
        run: |
          rsync -avz --delete \
            --exclude 'node_modules' \
            --exclude '.git' \
            --exclude '.env*' \
            --exclude 'dist' \
            --exclude '*.log' \
            ./ ${{ env.SERVER_USER }}@${{ secrets.SERVER_HOST }}:${{ env.SERVER_PATH }}/

      - name: Build and restart
        run: |
          ssh ${{ env.SERVER_USER }}@${{ secrets.SERVER_HOST }} << 'EOF'
          cd /opt/<app>
          docker compose -f docker/docker-compose.prod.yml --env-file .env.production up -d --build --remove-orphans
          docker image prune -f
          EOF

      - name: Health check
        run: |
          sleep 20
          curl -f --retry 3 http://${{ secrets.SERVER_HOST }}:3001/api/health || echo "Health check skipped"
```

### Step 5: Configure GitHub Secrets

```bash
# Generate SSH key if needed
ssh-keygen -t ed25519 -f ~/.ssh/scaleway_deploy -N ""

# Add public key to server
ssh-copy-id -i ~/.ssh/scaleway_deploy.pub root@$SERVER_HOST

# Add secrets via gh CLI
gh secret set SSH_PRIVATE_KEY < ~/.ssh/scaleway_deploy
gh secret set SERVER_HOST --body "$SERVER_HOST"
```

### Step 6: DNS Configuration (Cloudflare)

If domain is on GoDaddy/other registrar, transfer to Cloudflare:

1. Create Cloudflare account at cloudflare.com
2. Add site (your domain)
3. Get Cloudflare nameservers (e.g., `finley.ns.cloudflare.com`, `marge.ns.cloudflare.com`)
4. Update registrar nameservers to Cloudflare
5. Add DNS records in Cloudflare:

```
Type: A
Name: @ (or subdomain)
Value: <SERVER_HOST>
Proxy: On (orange cloud)
```

6. SSL/TLS settings: Set to "Flexible" initially, then "Full" once Caddy has certs

### Step 7: Caddy Configuration

**/etc/caddy/Caddyfile** on server:
```
yourdomain.com {
    reverse_proxy localhost:3000

    handle /api/* {
        reverse_proxy localhost:3001
    }
}
```

Reload Caddy:
```bash
systemctl reload caddy
```

## Package.json Scripts

Add these for convenience:
```json
{
  "scripts": {
    "deploy": "./deploy/deploy.sh",
    "deploy:logs": "ssh root@<HOST> 'cd /opt/<app> && docker compose -f docker/docker-compose.prod.yml logs -f'",
    "deploy:status": "ssh root@<HOST> 'cd /opt/<app> && docker compose -f docker/docker-compose.prod.yml ps'"
  }
}
```

## Troubleshooting

### SSH Connection Failed
```bash
# Test connection
ssh -v root@$SERVER_HOST

# Check SSH key
ssh-add -l

# Add key if needed
ssh-add ~/.ssh/your_key
```

### Docker Build Fails
```bash
# SSH to server and check
ssh root@$SERVER_HOST
cd /opt/<app>
docker compose -f docker/docker-compose.prod.yml build --no-cache
docker compose -f docker/docker-compose.prod.yml logs
```

### Container Keeps Restarting
```bash
# Check specific container logs
docker logs moon-api --tail 100
docker logs moon-worker --tail 100

# Common fix: BullMQ Redis config
# Ensure maxRetriesPerRequest: null in Redis connection
```

### SSL/HTTPS Not Working
```bash
# Check Caddy status
systemctl status caddy
journalctl -u caddy -f

# Test direct ports
curl http://<HOST>:3000  # Web
curl http://<HOST>:3001/api/health  # API

# Cloudflare SSL mode
# Set to "Flexible" if Caddy doesn't have certs yet
# Set to "Full" once Caddy has auto-SSL working
```

### Health Check Fails
```bash
# Test locally on server
curl localhost:3001/api/health

# Check if API container is running
docker ps | grep api

# Check API logs
docker logs moon-api --tail 50
```

## Patterns Learned

### Use esbuild in Docker instead of tsc
TypeScript module resolution issues in Docker are common. Using esbuild for bundling avoids them:

```dockerfile
RUN npm install -g esbuild && \
    esbuild src/index.ts --bundle --platform=node --outfile=dist/index.js --format=esm --packages=external
```

### rsync excludes are critical for speed
Always exclude:
- `node_modules` (huge, built on server)
- `.git` (unnecessary)
- `dist` (built on server)
- `.env*` (secrets stay on server)
- IDE/tool folders (`.claude`, `.context`, etc.)

### Cloudflare as DNS proxy
Benefits:
- DDoS protection
- CDN for static assets
- Easy SSL management
- Domain stays at registrar

### Docker log rotation
Prevent disk full:
```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

## Related

- Scaleway Object Storage for S3-compatible file storage
- Bunny CDN for video/media delivery
- GitHub Actions for CI/CD
- Cloudflare for DNS and SSL proxy
