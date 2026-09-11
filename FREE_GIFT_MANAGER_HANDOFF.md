# Free Gift Manager Application - Handoff Notes

## Project Location

Local folder:

```text
C:\Users\soura\Downloads\free-gift-manager-app
```

GitHub repository:

```text
https://github.com/anatomybrown-glitch/free-gift-manager-app.git
```

Production app URL:

```text
https://free-gift-manager.houseofsandhya.workers.dev
```

## Project Summary

Free Gift Manager is a Shopify app MVP built for Shopify merchants. The app lets the merchant create free gift rules from an embedded Shopify admin dashboard. On the storefront, the app checks the customer cart and automatically adds or removes free gifts based on rule conditions.

The app currently supports:

- Cart subtotal based free gift.
- Specific product based free gift.
- Products from selected collections based free gift.
- Collection subtotal based free gift.
- Multiple collection selection from the admin dashboard.
- Gift variant ID field.
- Gift product ID fallback when variant ID is not entered.
- Gift value display such as `Worth Rs 299`.
- Gift product price can be Rs 0 while value is shown separately.
- Auto add gift to cart.
- Remove gift when condition is no longer matched.
- Cart page support.
- Cart drawer support.
- Gift quantity/remove control guard.
- Multiple gift rules working together without repeated cart reload loops.

## Main Tech Stack

- Shopify custom app / custom distribution.
- Shopify theme app extension.
- Cloudflare Worker backend.
- Cloudflare D1 database.
- HTML, CSS, and JavaScript admin dashboard.
- Storefront JavaScript for cart gift logic.
- GitHub for code backup/version control.

## Important Files and Folders

```text
public/index.html
```

Admin dashboard HTML layout. Contains the app UI structure: sidebar, Rules screen, Create Rule form, Storefront Preview, Settings, collection picker modal, and cart preview.

```text
public/admin.js
```

Admin dashboard JavaScript. Handles tab switching, rule form, collection picker, API requests, admin token prompt, create/edit/duplicate/delete rule actions, and preview updates.

```text
public/styles.css
```

Admin dashboard styling.

```text
src/worker.js
```

Cloudflare Worker backend. Handles Shopify OAuth, API routes, rules, settings, collection/product lookup, and storefront config.

```text
schema.sql
```

Cloudflare D1 database schema.

```text
extensions/free-gift-manager/blocks/free-gift-manager.liquid
```

Shopify theme app extension app embed block. It loads the storefront script and passes the app URL.

```text
extensions/free-gift-manager/assets/free-gift-storefront.js
```

Storefront gift engine used by the theme app extension.

```text
public/free-gift-storefront.js
```

Storefront script copy served by the Worker/assets.

```text
wrangler.toml
```

Cloudflare Worker configuration.

```text
shopify.app.toml
```

Shopify app configuration.

```text
README.md
```

Basic project setup notes.

## NPM Commands

Install dependencies:

```bash
npm install
```

Run local Cloudflare Worker:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

Deploy Worker:

```bash
npm run deploy
```

Initialize local D1 database:

```bash
npm run db:init
```

Initialize remote D1 database:

```bash
npm run db:remote:init
```

## Cloudflare Configuration

Current `wrangler.toml` has:

```text
name = "free-gift-manager"
main = "src/worker.js"
compatibility_date = "2026-08-01"
APP_URL = "https://free-gift-manager.houseofsandhya.workers.dev"
SHOPIFY_SCOPES = "read_products"
```

D1 database binding:

```text
binding = "DB"
database_name = "free_gift_manager"
```

Required secrets:

```text
SHOPIFY_API_KEY
SHOPIFY_API_SECRET
```

Do not commit real secrets to GitHub.

## Shopify App Configuration

Current app name:

```text
Free Gift Manager
```

App URL:

```text
https://free-gift-manager.houseofsandhya.workers.dev
```

Redirect URL:

```text
https://free-gift-manager.houseofsandhya.workers.dev/auth/callback
```

Access scope:

```text
read_products
```

## Storefront Setup

In Shopify theme editor:

1. Open the active theme or duplicate test theme.
2. Go to App embeds.
3. Enable Free Gift Manager app embed.
4. Set App URL to:

```text
https://free-gift-manager.houseofsandhya.workers.dev
```

5. Save theme.

The storefront gift script will then load on customer pages.

## How the App Works

1. Merchant opens Free Gift Manager inside Shopify Admin.
2. Merchant creates a gift rule.
3. Rule is saved in Cloudflare D1.
4. Storefront script loads rule config from the Cloudflare Worker.
5. Customer adds products to cart.
6. Storefront script checks active rules against cart data.
7. If a rule matches, gift item is added to cart.
8. If the cart no longer matches, gift item is removed.
9. Cart page/cart drawer is refreshed carefully to avoid reload loops.

## Rule Types

### Cart Subtotal

Gift unlocks when eligible cart subtotal reaches minimum amount.

Example:

```text
Minimum subtotal in paise = 59900
Meaning = Rs 599
```

### Specific Product

Gift unlocks when a selected product/variant/handle exists in cart.

### Products From Collection

Gift unlocks when customer adds a required number of products from selected collections.

### Collection Subtotal

Gift unlocks when subtotal of products from selected collections reaches a minimum amount.

This is useful when free gift should apply only on selected collections, not on all store products.

## Gift Variant ID and Product ID

Shopify cart add API works best with variant ID. Even if a Shopify product looks like it has no variants, Shopify still creates a default variant internally.

Use:

```text
Gift variant ID
```

when available.

Use:

```text
Gift product ID
```

only as fallback. The backend/script can resolve first available variant from product data.

## Gift Price and Gift Worth

Recommended MVP method:

- Set gift product price to Rs 0 in Shopify product admin.
- Enter gift value in app rule, for example `299`.
- Storefront shows `Worth Rs 299`.
- Cart total remains correct because gift price is Rs 0.

Gift line properties can show:

```text
Gift: Free gift
Gift value: Rs 299
```

## Important Fixes Already Done

- Cart page gift add/remove fixed.
- Cart drawer gift add/remove improved.
- Stale gift cart state fixed.
- Legacy theme gift script conflict handled.
- Multiple gift rules matching together no longer cause repeated reload loops.
- Gift value display added.
- Gift product ID fallback added.
- Collection subtotal and multiple collection selection added.
- Direct gift add / gift quantity control support added.

## Common Issues to Check

### Gift does not add

Check:

- Rule status is active.
- Gift variant ID is correct.
- Gift product is available.
- Theme app embed is enabled.
- App URL is correct in theme app embed.
- Storefront config endpoint is loading.

### Gift does not remove

Check:

- Storefront script is latest.
- Rule condition is recalculating after cart quantity change.
- Cart drawer events are firing.
- Old theme gift code is not conflicting.

### Collections do not load in admin

Check:

- App is installed/reconnected.
- Shopify access token exists.
- Scope `read_products` is granted.
- Backend collection API is working.

### Too many attempts / 429 error

Usually caused by repeated cart update loop. Check:

- Multiple gift rules are not fighting.
- Legacy theme gift code is removed/disabled.
- Storefront script internal mutation guard is working.

## Suggested Next Improvements

- Replace simple admin token with stronger Shopify embedded app session validation.
- Add Shopify product/variant picker for gift item selection.
- Add analytics for gifts added, conversion lift, and revenue influenced.
- Add customer tag based rules.
- Add discount code based rules.
- Add gift exclusion rules.
- Add theme preset support for popular Shopify themes.
- Improve multi-store support for future custom distributions.
- Add stronger automated tests for storefront cart behaviour.

## Notes for Another AI Agent

Before making changes, read these files first:

```text
README.md
package.json
wrangler.toml
shopify.app.toml
schema.sql
src/worker.js
public/admin.js
public/free-gift-storefront.js
extensions/free-gift-manager/assets/free-gift-storefront.js
extensions/free-gift-manager/blocks/free-gift-manager.liquid
```

Do not remove existing cart stability guards without testing both:

- Cart page
- Cart side drawer

When changing gift rule logic, update both:

- Admin dashboard fields
- Storefront rule matching logic

When changing deployment URLs, update:

- `wrangler.toml`
- `shopify.app.toml`
- Shopify Partner app URLs
- Theme app embed App URL

## Current Project Report Files

College project report batches are stored here:

```text
C:\Users\soura\Downloads\free-gift-manager-app\output\docx
```

Generated report files:

```text
free-gift-manager-college-report-batch-1.docx
free-gift-manager-college-report-batch-2.docx
free-gift-manager-college-report-batch-3.docx
free-gift-manager-college-report-batch-4.docx
free-gift-manager-college-report-batch-5.docx
```
