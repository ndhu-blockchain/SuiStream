module sui_stream::wal;

use sui::coin::{Self, TreasuryCap};

public struct WAL has drop {}

fun init(witness: WAL, ctx: &mut TxContext) {
    let (treasury, metadata) = coin::create_currency(
        witness,
        9,
        b"WAL",
        b"Walrus Token",
        b"Token for Walrus Storage",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::public_transfer(treasury, tx_context::sender(ctx));
}

public entry fun mint(
    treasury_cap: &mut TreasuryCap<WAL>,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    coin::mint_and_transfer(treasury_cap, amount, recipient, ctx);
}
