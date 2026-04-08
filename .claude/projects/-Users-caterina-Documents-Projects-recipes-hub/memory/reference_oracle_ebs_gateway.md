---
name: Oracle EBS Data Gateway
description: MCP data gateway at gateway.dailyfoodsa.com connects to Oracle EBS with items_master, onhand_inventory, item_consumption, and other virtual sources
type: reference
---

The Oracle EBS data gateway is accessible via MCP at `https://gateway.dailyfoodsa.com/mcp` with bearer token auth.

**Available virtual sources (all backed by Oracle EBS):**
- `items_master` — Master item list with ITEM_CODE, ITEM_DESC, PRIMARY_UOM_CODE, ITEM_TYPE, STATUS, lead times
- `onhand_inventory` — Current on-hand by item, lot, warehouse, subinventory with expiry
- `item_consumption` — Material consumption by item over last 6 months
- `item_lead_times` — Pre/post/processing lead times and safety stock
- `branches` — Organization/branch list with operating unit mapping
- `pos_erp_item_map` — POS-to-ERP item mapping with UOM conversions

**Item type codes:** FG (Finished Goods), SFG (Semi-Finished Goods), P (Purchased/Raw Material), CO (Consumables), FA (Fixed Assets), FRT (Freight), SP (Spare Parts), SERVICES

**Raw material prefix:** `RM%` — ~469 active items including cheese, flour, oils, proteins, spices, sauces, etc.

**API protocol:** JSON-RPC 2.0 via Streamable HTTP. Tools: `query`, `list_sources`, `list_tables`, `describe_table`, `query_stats`. Virtual sources use `SELECT * FROM data WHERE ...` syntax with Oracle-style `FETCH FIRST N ROWS ONLY`.

**How to apply:** Use this gateway when the user needs live EBS data for ingredients, inventory, or item lookups. The MCP server is configured in `~/.claude/settings.json` as `mcp-data-gateway` but may not always load in session — fall back to direct HTTP calls.
