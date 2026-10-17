import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRenderGateway } from './render-start.js';

describe('YOUPI PG V2 — Render Production Gateway Integration Tests', () => {
  let gateway;
  const testPort = 19090;

  before(async () => {
    process.env.ENABLE_DEMO_STORE = 'true';
    gateway = await startRenderGateway({
      port: testPort,
      publicUrl: `http://127.0.0.1:${testPort}`
    });
  });

  after(async () => {
    if (gateway && gateway.close) {
      await gateway.close();
    }
  });

  test('1. Health check returns 200 OK with UP status', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'UP');
    assert.equal(data.service, 'youpi-pg-render-gateway');
  });

  test('2. /youpi.js is served with JavaScript content-type', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/youpi.js`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('javascript'));
    const text = await res.text();
    assert.ok(text.includes('YoupiCheckout') || text.includes('youpi'));
  });

  test('3. Merchant Admin is served at / and /admin', async () => {
    const res1 = await fetch(`http://127.0.0.1:${testPort}/`);
    assert.equal(res1.status, 200);
    const text1 = await res1.text();
    assert.ok(text1.includes('<!DOCTYPE html>') || text1.includes('Admin') || text1.includes('YOUPI'));

    const res2 = await fetch(`http://127.0.0.1:${testPort}/admin`);
    assert.equal(res2.status, 200);
  });

  test('4. API /api/v1/payments creates payment session and returns checkoutUrl', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/v1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: `ORDER-TEST-${Date.now()}`,
        amount: 499,
        currency: 'INR'
      })
    });
    assert.ok(res.status === 200 || res.status === 201);
    const body = await res.json();
    assert.ok(body.paymentId);
    assert.ok(body.checkoutUrl);
    assert.ok(body.checkoutUrl.includes(`/checkout/${body.paymentId}`));
  });

  test('5. /checkout/:id loads dynamic checkout page', async () => {
    // Create payment first
    const createRes = await fetch(`http://127.0.0.1:${testPort}/api/v1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: `ORDER-CHECKOUT-${Date.now()}`,
        amount: 250,
        currency: 'INR'
      })
    });
    const { paymentId } = await createRes.json();

    const checkoutRes = await fetch(`http://127.0.0.1:${testPort}/checkout/${paymentId}`);
    assert.equal(checkoutRes.status, 200);
    const html = await checkoutRes.text();
    assert.ok(html.includes(paymentId));
  });

  test('6. /checkout/:id/qr.svg returns dynamic vector SVG QR', async () => {
    const createRes = await fetch(`http://127.0.0.1:${testPort}/api/v1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: `ORDER-QR-${Date.now()}`,
        amount: 150,
        currency: 'INR'
      })
    });
    const { paymentId } = await createRes.json();

    const qrRes = await fetch(`http://127.0.0.1:${testPort}/checkout/${paymentId}/qr.svg`);
    assert.equal(qrRes.status, 200);
    assert.ok(qrRes.headers.get('content-type').includes('svg'));
    const svg = await qrRes.text();
    assert.ok(svg.includes('<svg'));
  });

  test('7. /youpi-sms-gateway.apk is downloadable', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/youpi-sms-gateway.apk`);
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get('content-length')) > 100000);
  });
});
