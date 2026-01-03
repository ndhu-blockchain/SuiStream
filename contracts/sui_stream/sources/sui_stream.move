module sui_stream::video_platform;

use std::string::String;
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;

const EInvalidId: u64 = 1;
const ENotAuthorized: u64 = 2;
const EInsufficientPayment: u64 = 3;
const EInvalidFeePercentage: u64 = 4;

/// 管理員權限憑證
public struct AdminCap has key, store {
    id: UID,
}

/// 平台設定物件
public struct PlatformConfig has key {
    id: UID,
    fee_address: address,
    fee_percentage: u64,
}

// 影片物件
public struct Video has key, store {
    id: UID,
    title: String,
    description: String,
    m3u8_blob_id: String,
    video_blob_id: String,
    cover_blob_id: String,
    creator: address,
    seal_id: vector<u8>,
    key_blob_id: String,
    price: u64,
}

// 觀看憑證物件
public struct AccessPass has key, store {
    id: UID,
    video_id: ID,
}

// 影片建立事件
public struct VideoCreated has copy, drop {
    id: ID,
    title: String,
    creator: address,
    price: u64,
    cover_blob_id: String,
}

// 影片購買事件
public struct VideoPurchased has copy, drop {
    video_id: ID,
    buyer: address,
}

// 平台初始化事件
public struct PlatformInitialized has copy, drop {
    config_id: ID,
    admin_cap_id: ID,
    fee_address: address,
    fee_percentage: u64,
}

fun init(ctx: &mut TxContext) {
    // 建立管理員鑰匙並交給部署者
    let admin_cap = AdminCap { id: object::new(ctx) };
    let admin_cap_id = object::id(&admin_cap);
    transfer::public_transfer(admin_cap, ctx.sender());

    // 建立初始設定
    let config = PlatformConfig {
        id: object::new(ctx),
        fee_address: ctx.sender(),
        fee_percentage: 5,
    };
    let config_id = object::id(&config);
    transfer::share_object(config);

    event::emit(PlatformInitialized {
        config_id,
        admin_cap_id,
        fee_address: ctx.sender(),
        fee_percentage: 5,
    });
}

// AdminCap 可以更新平台設定（抽成地址）
entry fun update_platform_address(_: &AdminCap, config: &mut PlatformConfig, new_address: address) {
    config.fee_address = new_address;
}

// AdminCap 可以更新平台設定（抽成比例）
entry fun update_platform_fee_percentage(
    _: &AdminCap,
    config: &mut PlatformConfig,
    new_percentage: u64,
) {
    assert!(new_percentage <= 100, EInvalidFeePercentage);
    config.fee_percentage = new_percentage;
}

// 建立影片
entry fun create_video(
    title: String,
    description: String,
    m3u8_blob_id: String,
    video_blob_id: String,
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
        title,
        description,
        m3u8_blob_id,
        video_blob_id,
        cover_blob_id,
        creator: ctx.sender(),
        seal_id,
        key_blob_id,
        price,
    };

    event::emit(VideoCreated {
        id: video_id,
        title: video.title,
        creator: video.creator,
        price: video.price,
        cover_blob_id: video.cover_blob_id,
    });

    transfer::share_object(video);
}

// 購買影片邏輯
public fun buy_video_logic(
    config: &PlatformConfig,
    video: &mut Video,
    mut payment: Coin<SUI>,
    ctx: &mut TxContext,
): AccessPass {
    // 檢查金額是否足夠
    assert!(payment.value() >= video.price, EInsufficientPayment);

    // 計算抽成金額
    let fee_amount = (video.price * config.fee_percentage) / 100;

    // 拆分並轉帳手續費給平台
    let fee_coin = coin::split(&mut payment, fee_amount, ctx);
    transfer::public_transfer(fee_coin, config.fee_address);

    // TODO: 存續基金

    // 將剩餘金額轉給影片創作者
    transfer::public_transfer(payment, video.creator);

    // 建立並發送事件
    event::emit(VideoPurchased {
        video_id: object::id(video),
        buyer: ctx.sender(),
    });

    // 回傳憑證
    AccessPass {
        id: object::new(ctx),
        video_id: object::id(video),
    }
}

// 購買影片接口
entry fun buy_video(
    config: &PlatformConfig,
    video: &mut Video,
    payment: Coin<SUI>,
    ctx: &mut TxContext,
) {
    // 呼叫邏輯拿到憑證
    let pass = buy_video_logic(config, video, payment, ctx);

    // 憑證轉移
    transfer::public_transfer(pass, ctx.sender());
}

// Seal approval 檢查（Video Creator）
entry fun seal_approve_creator(id: vector<u8>, video: &Video, ctx: &TxContext) {
    assert!(video.seal_id == id, EInvalidId);
    assert!(video.creator == ctx.sender(), ENotAuthorized);
}

// Seal approval 檢查（AccessPass）
entry fun seal_approve_pass(id: vector<u8>, video: &Video, pass: &AccessPass, _ctx: &TxContext) {
    assert!(video.seal_id == id, EInvalidId);
    assert!(pass.video_id == object::id(video), ENotAuthorized);
}
