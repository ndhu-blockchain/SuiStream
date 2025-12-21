module sui_stream::mock_dex;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::sui::SUI;

// --- Error Codes ---
const EInsufficientBalance: u64 = 1;

// --- Structs ---
// 銀行物件：存放 SUI 和 WAL 的資金池
public struct DexBank<phantom T> has key {
    id: UID,
    sui: Balance<SUI>,
    token: Balance<T>,
}

// --- Functions ---

// 1. [初始化] 建立銀行 (任何人都可以呼叫，建立後變成共享物件)
public fun create_bank<T>(ctx: &mut TxContext) {
    let bank = DexBank<T> {
        id: object::new(ctx),
        sui: balance::zero(),
        token: balance::zero(),
    };
    // 分享物件，讓所有人都能存取
    transfer::share_object(bank);
}

// 2. [補貨] 存入 WAL (增加流動性)
public fun deposit_token<T>(bank: &mut DexBank<T>, input: Coin<T>) {
    let balance = coin::into_balance(input);
    balance::join(&mut bank.token, balance);
}

// 3. [提款] 提領 SUI (讓你把賺到的 SUI 領出來)
public fun withdraw_sui<T>(bank: &mut DexBank<T>, ctx: &mut TxContext): Coin<SUI> {
    let amount = balance::value(&bank.sui);
    coin::take(&mut bank.sui, amount, ctx)
}

// 4. [核心功能] Swap: SUI -> WAL
// 重點：這裡回傳 Coin<T>，讓你在前端 PTB 可以直接把這個 Coin 拿去付 Walrus 費用
public fun swap_sui_for_token<T>(
    bank: &mut DexBank<T>,
    input: Coin<SUI>,
    ctx: &mut TxContext,
): Coin<T> {
    let sui_amount = coin::value(&input);

    // 匯率設定：1 SUI = 0.5 WAL (即 2 SUI 換 1 WAL)
    // 公式：WAL = SUI / 2
    let token_amount = sui_amount / 2;

    // 檢查銀行餘額夠不夠賠
    assert!(balance::value(&bank.token) >= token_amount, EInsufficientBalance);

    // 1. 銀行收下 SUI
    let sui_balance = coin::into_balance(input);
    balance::join(&mut bank.sui, sui_balance);

    // 2. 銀行吐出 WAL
    coin::take(&mut bank.token, token_amount, ctx)
}
