module sui_stream::video_platform;

use std::string::String;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;

const EInvalidId: u64 = 1;
const ENotAuthorized: u64 = 2;
const EInsufficientPayment: u64 = 3;

public struct Video has key, store {
    id: UID,
    title: String,
    description: String,
    ipfs_hash: String,
    cover_blob_id: String, // 影片封面 Blob ID
    creator: address,
    seal_id: vector<u8>, // Seal 識別 ID (加密金鑰)
    key_blob_id: String, // 加密金鑰在 Walrus 上的 Blob ID
    price: u64, // 影片價格 (SUI)
}

public struct AccessPass has key, store {
    id: UID,
    video_id: ID,
}

public struct VideoCreated has copy, drop {
    id: ID,
    title: String,
    creator: address,
    price: u64,
    cover_blob_id: String,
}

public struct VideoPurchased has copy, drop {
    video_id: ID,
    buyer: address,
}

public entry fun create_video(
    title: String,
    description: String,
    ipfs_hash: String,
    cover_blob_id: String,
    seal_id: vector<u8>,
    key_blob_id: String,
    price: u64,
    ctx: &mut TxContext,
) {
    let id = object::new(ctx);
    let video_id = object::uid_to_inner(&id);
    let video = Video {
        id,
        title: title,
        description: description,
        ipfs_hash: ipfs_hash,
        cover_blob_id: cover_blob_id,
        creator: ctx.sender(),
        seal_id: seal_id,
        key_blob_id: key_blob_id,
        price: price,
    };

    event::emit(VideoCreated {
        id: video_id,
        title: video.title,
        creator: video.creator,
        price: video.price,
        cover_blob_id: video.cover_blob_id,
    });

    // 將影片物件設為共享，讓所有人都能看到並購買
    transfer::share_object(video);
}

public entry fun buy_video(video: &mut Video, payment: Coin<SUI>, ctx: &mut TxContext) {
    assert!(payment.value() >= video.price, EInsufficientPayment);

    // TODO: 平台抽成
    // TODO: 存續基金

    // 支付給創作者
    transfer::public_transfer(payment, video.creator);

    // 發放 AccessPass 給購買者
    let pass = AccessPass {
        id: object::new(ctx),
        video_id: object::id(video),
    };

    event::emit(VideoPurchased {
        video_id: object::id(video),
        buyer: ctx.sender(),
    });

    transfer::public_transfer(pass, ctx.sender());
}

// 創作者專用的驗證 (無需 AccessPass)
public entry fun seal_approve(id: vector<u8>, video: &Video, ctx: &TxContext) {
    assert!(video.seal_id == id, EInvalidId);
    assert!(video.creator == ctx.sender(), ENotAuthorized);
}

// 購買者專用的驗證 (需持有 AccessPass)
public entry fun seal_approve_with_pass(
    id: vector<u8>,
    video: &Video,
    pass: &AccessPass,
    ctx: &TxContext,
) {
    assert!(video.seal_id == id, EInvalidId);
    assert!(pass.video_id == object::id(video), ENotAuthorized);
}

public entry fun seal_approve_viewer(
    id: vector<u8>,
    video: &Video,
    pass: &AccessPass,
    _ctx: &TxContext,
) {
    assert!(video.seal_id == id, EInvalidId);
    assert!(pass.video_id == object::id(video), ENotAuthorized);
}
