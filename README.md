# SuiStream

SuiStream 是一個基於 Sui 區塊鏈與 Walrus 去中心化儲存的影音串流平台。

## 前置需求

- [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install)
- [Walrus CLI](https://docs.walrus.site/usage/client-cli.html) (用於獲取 WAL 代幣)
- Node.js & pnpm

## 合約部署 (Contract Deployment)

### 1. 部署 Mock DEX (用於代幣交換)

Mock DEX 用於模擬 SUI 與 WAL 代幣之間的交換。

```bash
sui client publish --gas-budget 100000000 contracts/mock_dex
```

部署完成後，請記錄以下資訊：

- **Package ID**: `Immutable` 物件的 ID。
- **DexBank ID**: `Shared` 物件的 ID (類型為 `DexBank`).

### 2. 部署 Video Platform (核心邏輯)

這是主要的影音平台合約。

```bash
sui client publish --gas-budget 100000000 contracts/sui_stream
```

部署完成後，請記錄：

- **Package ID**: `Immutable` 物件的 ID。

---

## Mock DEX 流動性補充 (Liquidity Refill)

為了讓使用者能夠在平台上購買影片，Mock DEX 需要有足夠的 WAL 代幣流動性供使用者用 SUI 交換。

### 1. 獲取官方 WAL 代幣

使用 Walrus CLI 從水龍頭獲取 WAL 代幣 (需消耗少量 SUI)。

```bash
walrus get-wal
```

### 2. 查詢 WAL 代幣物件 ID

執行以下指令查看你擁有的物件，找到類型為 `...::wal::WAL` 的 Coin Object ID。

```bash
sui client objects
```

或者直接查看剛剛 `walrus get-wal` 的輸出結果。

### 3. 將 WAL 存入 Mock DEX

將獲取的 WAL 代幣存入 DEX Bank 以提供流動性。

- `<MOCK_DEX_PACKAGE_ID>`: 步驟 1 部署的 Mock DEX Package ID
- `<WAL_COIN_TYPE>`: 官方 WAL 代幣類型 (通常為 `0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL`)
- `<BANK_ID>`: 步驟 1 部署產生的 DexBank ID
- `<WAL_COIN_OBJECT_ID>`: 步驟 2 查到的 WAL Coin Object ID

```bash
sui client call \
  --package 0x048124ed3fe7405b210ea4f28f2d20590749fe65af58dc1e3779f0c6ebd6d091 \
  --module mock_dex \
  --function deposit_token \
  --type-args 0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL \
  --args 0x77ce005108e30bde1385cbd2c416bd45cfff59c372ad4da16dae026471fbd0dd <WAL_COIN_OBJECT_ID> \
  --gas-budget 10000000
```

### 4. 領出 SUI

```bash
PACKAGE_ID=0x048124ed3fe7405b210ea4f28f2d20590749fe65af58dc1e3779f0c6ebd6d091
BANK_ID=0x77ce005108e30bde1385cbd2c416bd45cfff59c372ad4da16dae026471fbd0dd
WAL_TYPE=0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL
MY_ADDRESS=$(sui client active-address)

sui client ptb \
  --move-call "$PACKAGE_ID::mock_dex::withdraw_sui<$WAL_TYPE>" @$BANK_ID \
  --assign sui_coin \
  --transfer-objects "[sui_coin]" @$MY_ADDRESS \
  --gas-budget 10000000
```

---

## 前端設定 (Frontend Setup)

1.  進入前端目錄：

    ```bash
    cd frontend
    ```

2.  安裝套件：

    ```bash
    pnpm install
    ```

3.  修改設定檔 `src/lib/sui.ts`：
    將上述部署獲得的 Package ID 和 Bank ID 填入對應變數：

    - `MOCK_DEX_PACKAGE_ID`
    - `VIDEO_PLATFORM_PACKAGE_ID`
    - `MOCK_DEX_BANK_ID`

4.  啟動開發伺服器：
    ```bash
    pnpm dev
    ```

---

## 前端部署：Cloudflare Pages (GitHub Actions)

此專案已加入 GitHub Actions workflow：只有推送到 `prod` 分支才會部署到 Cloudflare Pages；PR 只會跑 build 不會部署。

### 1. Cloudflare Pages 建立專案

到 Cloudflare Dashboard → Workers & Pages → Pages → Create project，建立一個 Pages 專案。

- **Project name**：`suistream`（如果你用別的名字，請同步修改 workflow 的 `projectName`）

### 2. 設定 GitHub Repo Secrets

在 GitHub Repo → Settings → Secrets and variables → Actions → New repository secret，新增：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Workflow 位置：[.github/workflows/cloudflare-pages.yml](.github/workflows/cloudflare-pages.yml)

### 3. 部署方式

- Push 到 `prod`：自動部署 Production
- 開 PR：只跑 build（不部署）

> 備註：如果你的主要開發分支是 `main`，可以用「合併 `main` → `prod`」作為上線流程；只有 `prod` 更新時才會觸發部署。
