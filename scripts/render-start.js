import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { runMigrations, getDatabase, MerchantRepository } from '../packages/db/src/index.js';
import { startServer as startPaymentApi } from '../apps/payment-api/src/index.js';
import { startCheckoutServer } from '../apps/checkout-portal/src/index.js';
import { startAdminServer } from '../apps/merchant-admin/src/index.js';
import { startCoinWalletStore } from '../apps/coin-wallet-store/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// 1. Authoritative Runtime Environment Setup
process.env.YOUPI_MODE = 'render';
process.env.NODE_ENV = 'production';

// Load .env if present
try {
  const rootEnv = path.resolve(rootDir, '.env');
  if (fs.existsSync(rootEnv) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(rootEnv);
  }
} catch {}

export async function startRenderGateway(options = {}) {
  // Load .env if present
  try {
    const rootEnv = path.resolve(rootDir, '.env');
    if (fs.existsSync(rootEnv) && typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(rootEnv);
    }
  } catch {}

  const GATEWAY_PORT = Number(options.port || process.env.PORT || 10000);
  const PAYMENT_API_PORT = Number(options.paymentApiPort || process.env.PAYMENT_API_PORT || 6100);
  const CHECKOUT_PORTAL_PORT = Number(options.checkoutPortalPort || process.env.CHECKOUT_PORTAL_PORT || 7000);
  const MERCHANT_ADMIN_PORT = Number(options.merchantAdminPort || process.env.MERCHANT_ADMIN_PORT || 6001);
  const COIN_STORE_PORT = Number(options.coinStorePort || process.env.COIN_STORE_PORT || 5000);

  process.env.PAYMENT_API_PORT = String(PAYMENT_API_PORT);
  process.env.CHECKOUT_PORTAL_PORT = String(CHECKOUT_PORTAL_PORT);
  process.env.MERCHANT_ADMIN_PORT = String(MERCHANT_ADMIN_PORT);
  process.env.COIN_STORE_PORT = String(COIN_STORE_PORT);

  // Public Host URL (Render injects RENDER_EXTERNAL_URL=https://<app>.onrender.com)
  const rawPublicUrl = (options.publicUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || `http://localhost:${GATEWAY_PORT}`).trim().replace(/\/+$/, '');
  process.env.PUBLIC_URL = rawPublicUrl;
  process.env.BASE_PAYMENT_API_URL = rawPublicUrl;
  process.env.BASE_CHECKOUT_URL = rawPublicUrl;
  process.env.BASE_ADMIN_URL = `${rawPublicUrl}/admin`;
  process.env.BASE_DEMO_STORE_URL = `${rawPublicUrl}/store`;
  console.log('====================================================');
  console.log('🚀 Starting YOUPI PG V2 — Render Production Gateway');
  console.log('====================================================');
  console.log(`[✓] Gateway Public URL: ${rawPublicUrl}`);
  console.log(`[✓] External Port:      ${GATEWAY_PORT}`);

  // 1. Run database initialization and migrations
  console.log('[1/4] Initializing SQLite database & applying migrations...');
  const migrationResult = runMigrations();
  console.log(`[✓] Database ready. Default merchant: ${migrationResult.defaultMerchant.businessName}`);

  // 2. Start internal services in-process
  console.log('[2/4] Starting internal gateway services on 127.0.0.1...');
  
  const paymentApp = await startPaymentApi(PAYMENT_API_PORT);
  console.log(`[✓] Payment Core REST Engine active on :${PAYMENT_API_PORT}`);

  const checkoutApp = await startCheckoutServer(CHECKOUT_PORTAL_PORT);
  console.log(`[✓] Checkout Portal active on :${CHECKOUT_PORTAL_PORT}`);

  const adminApp = await startAdminServer(MERCHANT_ADMIN_PORT);
  console.log(`[✓] Merchant Admin Hub active on :${MERCHANT_ADMIN_PORT}`);

  let storeApp = null;
  const enableDemoStore = process.env.ENABLE_DEMO_STORE !== 'false';
  if (enableDemoStore) {
    try {
      storeApp = await startCoinWalletStore(COIN_STORE_PORT);
      console.log(`[✓] Showcase Demo Store active on :${COIN_STORE_PORT}`);
    } catch (e) {
      console.warn(`[!] Demo store failed to start: ${e.message}`);
    }
  }

  // Helper: Streaming reverse proxy
  function proxyRequest(req, res, targetPort) {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');

    const headers = {
      ...req.headers,
      host: `127.0.0.1:${targetPort}`,
      'x-forwarded-host': req.headers.host || '',
      'x-forwarded-proto': proto,
      'x-forwarded-for': clientIp
    };

    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Gateway service unavailable',
          targetPort,
          message: err.message
        }));
      }
    });

    req.on('aborted', () => {
      try { proxyReq.destroy(); } catch {}
    });

    res.on('close', () => {
      try { proxyReq.destroy(); } catch {}
    });

    req.pipe(proxyReq);
  }

  // 3. Create Gateway Router HTTP Server
  console.log('[3/4] Binding unified public gateway on 0.0.0.0:' + GATEWAY_PORT + '...');

  const gatewayServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Health Check Endpoint (Essential for Render deployment verification)
    if (pathname === '/health' || pathname === '/healthz' || pathname === '/api/health') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        status: 'UP',
        service: 'youpi-pg-render-gateway',
        timestamp: new Date().toISOString(),
        publicUrl: rawPublicUrl,
        mode: 'render'
      }));
      return;
    }

    // OpenAPI Specification
    if (pathname === '/openapi.yaml') {
      const openApiPath = path.resolve(rootDir, 'openapi.yaml');
      if (fs.existsSync(openApiPath)) {
        res.writeHead(200, {
          'Content-Type': 'text/yaml; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(fs.readFileSync(openApiPath, 'utf8'));
        return;
      }
    }

    // Official Android Companion APK Download
    if (pathname === '/youpi-sms-gateway.apk' || pathname === '/api/v1/admin/sms-gateway/download-apk') {
      const apkCandidates = [
        path.resolve(rootDir, 'apps/android-observer-app/youpi-sms-gateway.apk'),
        path.resolve(rootDir, 'apps/payment-api/public/youpi-sms-gateway.apk'),
        path.resolve(rootDir, 'apps/merchant-admin/public/youpi-sms-gateway.apk')
      ];
      for (const p of apkCandidates) {
        if (fs.existsSync(p)) {
          const stat = fs.statSync(p);
          res.writeHead(200, {
            'Content-Type': 'application/vnd.android.package-archive',
            'Content-Disposition': 'attachment; filename="youpi-sms-gateway.apk"',
            'Content-Length': stat.size,
            'Access-Control-Allow-Origin': '*'
          });
          fs.createReadStream(p).pipe(res);
          return;
        }
      }
    }

    // Customer Checkout Portal, Dynamic QR SVG, Universal SDK, and Payment Icons -> :7000
    if (
      pathname === '/youpi.js' ||
      pathname === '/sdk/youpi.js' ||
      pathname === '/sdk/youpi-checkout.js' ||
      pathname.startsWith('/checkout') ||
      pathname.startsWith('/icons/')
    ) {
      proxyRequest(req, res, CHECKOUT_PORTAL_PORT);
      return;
    }

    // Demo Store / Showcase Routes -> :5000 (if enabled)
    if (
      enableDemoStore && (
        pathname === '/store' ||
        pathname.startsWith('/store/') ||
        pathname === '/wallet' ||
        pathname.startsWith('/wallet/') ||
        pathname.startsWith('/assets/') ||
        pathname.startsWith('/order-') ||
        pathname === '/success' ||
        pathname === '/failed' ||
        pathname === '/suspicious' ||
        pathname === '/expired' ||
        pathname === '/cancelled' ||
        pathname === '/api/checkout' ||
        pathname === '/api/verify-payment' ||
        pathname === '/api/wallet-balance' ||
        pathname === '/api/webhook' ||
        pathname.startsWith('/demo')
      )
    ) {
      proxyRequest(req, res, COIN_STORE_PORT);
      return;
    }

    // Core Payment API & Observer Endpoints -> :6100
    if (pathname.startsWith('/api/')) {
      // Special: Admin ticket/service proxies route to admin if needed
      if (pathname.startsWith('/api/admin/tickets')) {
        proxyRequest(req, res, MERCHANT_ADMIN_PORT);
        return;
      }
      proxyRequest(req, res, PAYMENT_API_PORT);
      return;
    }

    // Default: Merchant Admin Dashboard & Cashier Counter -> :6001
    proxyRequest(req, res, MERCHANT_ADMIN_PORT);
  });

  return new Promise((resolve) => {
    gatewayServer.listen(GATEWAY_PORT, '0.0.0.0', () => {
      console.log('====================================================');
      console.log('🟢 YOUPI PG V2 RENDER GATEWAY ONLINE & ACTIVE');
      console.log('====================================================');
      console.log(`• Merchant Admin Dashboard: ${rawPublicUrl}/ (or ${rawPublicUrl}/admin)`);
      console.log(`• Universal SDK Script:     ${rawPublicUrl}/youpi.js`);
      console.log(`• Checkout Portal Modal:    ${rawPublicUrl}/checkout/:id`);
      console.log(`• Core Payment REST API:    ${rawPublicUrl}/api/v1/...`);
      console.log(`• SMS Gateway Companion:    ${rawPublicUrl}/youpi-sms-gateway.apk`);
      if (enableDemoStore) {
        console.log(`• Showcase Demo Store:      ${rawPublicUrl}/store`);
      }
      console.log(`• Health Check Endpoint:    ${rawPublicUrl}/health`);
      console.log('====================================================');

      const closeAll = async () => {
        try { gatewayServer.close(); } catch {}
        try { if (paymentApp?.close) await paymentApp.close(); } catch {}
        try { if (checkoutApp?.close) await checkoutApp.close(); } catch {}
        try { if (adminApp?.close) await adminApp.close(); } catch {}
        try { if (storeApp?.close) await storeApp.close(); } catch {}
      };

      const shutdown = async () => {
        console.log('\nStopping Render Gateway services gracefully...');
        await closeAll();
        console.log('All gateway services stopped cleanly.');
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      resolve({
        gatewayServer,
        port: GATEWAY_PORT,
        publicUrl: rawPublicUrl,
        close: closeAll
      });
    });
  });
}

// Auto-run when executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startRenderGateway();
}
