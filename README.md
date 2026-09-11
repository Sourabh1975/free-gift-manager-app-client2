# Free Gift Manager MVP

Shopify free gift app MVP for any Shopify merchant.

## Features in this MVP

- Cloudflare Worker backend
- Cloudflare D1 database
- Shopify OAuth install endpoints
- Merchant dashboard UI
- Create, edit, duplicate, delete gift rules
- Product trigger: product handle, product ID, or variant ID
- Collection quantity trigger: unlock a gift after a configurable number of items from selected collections
- Collection subtotal trigger: count only products from selected collections toward the spend threshold
- Searchable Shopify collection picker with multi-select and removable selected-collection chips
- Published-collection picker fallback without OAuth, plus manual collection URL, handle, or ID entry
- Cart subtotal trigger
- Editable gift value displayed as `Worth Rs ...` in the widget and as a gift line property
- Optional gift product ID fallback that resolves the first available variant when no variant ID is entered
- Storefront script that shows a gift message and auto-adds a gift variant
- Basic settings page
- Theme app extension app embed

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a D1 database:

```bash
npx wrangler d1 create free_gift_manager
```

Copy the returned database ID into `wrangler.toml`.

3. Create local tables:

```bash
npm run db:init
```

4. Create a Shopify Partner app and add env vars:

```bash
npx wrangler secret put SHOPIFY_API_KEY
npx wrangler secret put SHOPIFY_API_SECRET
```

For local development, create `.dev.vars`:

```env
SHOPIFY_API_KEY=your_api_key
SHOPIFY_API_SECRET=your_api_secret
APP_URL=http://localhost:8787
SHOPIFY_SCOPES=read_products
```

5. Run local dev:

```bash
npm run dev
```

Open:

```text
http://localhost:8787/?shop=your-store.myshopify.com
```

6. Shopify Partner Dashboard URLs:

```text
App URL:
https://your-cloudflare-url/

Allowed redirect URL:
https://your-cloudflare-url/auth/callback
```

## Cloudflare deploy

1. Push this folder to GitHub.
2. In Cloudflare, create a Worker and connect the GitHub repository.
3. Set secrets:
   - `SHOPIFY_API_KEY`
   - `SHOPIFY_API_SECRET`
4. Set vars:
   - `APP_URL=https://your-cloudflare-url`
   - `SHOPIFY_SCOPES=read_products`
5. Run remote DB migration:

```bash
npm run db:remote:init
```

## Theme app extension

The MVP includes:

```text
extensions/free-gift-manager/blocks/free-gift-manager.liquid
extensions/free-gift-manager/assets/free-gift-storefront.js
```

Add the app embed in the Shopify theme editor and set `App URL` to the deployed Cloudflare URL.

## Important MVP notes

- Gift products should normally be zero-priced products or discounted separately.
- This MVP adds the gift variant to cart. It does not create native Shopify discounts yet.
- Cart drawer support depends on theme selectors. Use Settings > Cart drawer selector if needed.
- Collection triggers accept up to 20 comma-separated handles, URLs, or IDs, deduplicate overlapping products, and refresh published collection membership every five minutes.
- Use a collection handle or collection URL when OAuth has not been reconnected; collection IDs require a stored Admin API session.
- For production, add stronger embedded app session validation and webhook handling.
