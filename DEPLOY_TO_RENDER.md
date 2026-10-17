# Deploying YOUPI PG V2 to Render

This guide outlines how to deploy your **YOUPI PG V2** self-hosted UPI payment gateway to [Render](https://render.com).

---

## 1. How It Works on Render

Render web services provide **one public port** (`$PORT`) and a single HTTPS domain (e.g. `https://your-gateway.onrender.com`).

The gateway includes a built-in **Render Production Gateway** ([`scripts/render-start.js`](file:///c:/Users/Dell/Desktop/payment/scripts/render-start.js)) that runs inside a single lightweight Node.js process:
- **`GET /health`**: Instant 200 OK health check for Render zero-downtime deploys.
- **`GET /` & `/admin`**: Merchant Admin Dashboard (configure VPAs, view real-time orders, pair Android APK).
- **`GET /youpi.js`**: Distributable universal one-script frontend integration for merchants.
- **`GET /checkout/:id`**: Dynamic responsive checkout modal with vector SVG QR.
- **`ALL /api/*`**: Core REST API & real-time Server-Sent Events (SSE) payment status streams.
- **`GET /youpi-sms-gateway.apk`**: Downloadable Android Companion APK for SMS observation.
- **`ALL /store`**: Built-in showcase store for testing payments end-to-end.

---

## 2. Deploying to Render (2 Options)

### Option A: 1-Click Blueprint Deploy (Recommended)

1. **Push your code to your GitHub account**:
   ```bash
   git add .
   git commit -m "Add Render gateway configuration and render.yaml"
   git remote set-url origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
2. Log in to [Render Dashboard](https://dashboard.render.com).
3. Click **"New +"** in the top right and select **"Blueprint"**.
4. Connect your GitHub repository. Render reads [`render.yaml`](file:///c:/Users/Dell/Desktop/payment/render.yaml) automatically and sets up:
   - Build Command: `npm install && npm run build`
   - Start Command: `npm run start:render`
   - Node Version: `22`
   - Health Check Path: `/health`
   - Auto-generated cryptographic secrets.
5. Click **"Apply"**. Render will build and deploy your gateway in ~2 minutes!

---

### Option B: Manual Web Service Deploy

If you prefer to create the Web Service manually:

1. Click **"New +"** > **"Web Service"** and select your GitHub repository.
2. Configure settings:
   - **Name**: `youpi-payment-gateway`
   - **Region**: Any (e.g., Singapore or Oregon)
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm run start:render` (or `npm start`)
   - **Health Check Path**: `/health`
3. In **Environment Variables**, add:

| Variable | Recommended Value | Description |
| :--- | :--- | :--- |
| `NODE_VERSION` | `22.13.0` | Node.js runtime version |
| `NODE_ENV` | `production` | Production mode |
| `YOUPI_MODE` | `render` | Activates unified Render gateway |
| `ENCRYPTION_MASTER_KEY` | *(Click "Generate")* | 32-byte master encryption secret |
| `JWT_SECRET` | *(Click "Generate")* | Admin session & token secret |
| `ANDROID_ENROLLMENT_SECRET`| *(Click "Generate")* | Secret used to pair Android SMS gateway |
| `DEFAULT_APP_NAME` | `YOUPI PG` | Your brand name |
| `ENABLE_DEMO_STORE` | `true` | Enables the `/store` showcase |

4. Click **"Create Web Service"**.

---

## 3. Post-Deployment Setup (5 Minutes)

Once your Render service status shows **"Live"**:

1. **Access your Merchant Dashboard**:
   - Open: `https://<your-service-name>.onrender.com/` (or `/admin`)
2. **Configure your Receiving UPI VPA**:
   - Navigate to **"Receiving Accounts / VPAs"**.
   - Add your UPI ID (e.g. `yourbusiness@upi`) and payee name.
3. **Download & Pair the Android Observer**:
   - Download the APK directly from: `https://<your-service-name>.onrender.com/youpi-sms-gateway.apk`.
   - Install it on the Android phone with your bank SIM card.
   - Go to the **"Android SMS Gateway"** tab in Merchant Admin and scan the QR code to pair your handset!
4. **Embed in your website**:
   ```html
   <!-- 1. Include script -->
   <script src="https://<your-service-name>.onrender.com/youpi.js"></script>

   <!-- 2. Payment button -->
   <button data-youpi-pay data-order-id="ORDER-101" data-amount="499">
     Pay ₹499 via UPI
   </button>
   ```

---

## 4. SQLite Data Persistence Note

- On **Render Free Tier**, the SQLite database persists while the service is running, but restarts reset disk state.
- For 100% persistent production storage across redeployments, upgrade the Web Service to **Starter Plan** ($7/month), click **"Disks"** > **"Add Disk"**:
  - Mount Path: `/var/data`
  - Size: `1 GB`
  - Set Environment Variable: `SQLITE_DB_PATH=/var/data/youpi_pg.sqlite`
