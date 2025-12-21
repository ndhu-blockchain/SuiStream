module sui_stream::video_platform;

use std::string::String;
use sui::event;

const EInvalidId: u64 = 1;
const ENotAuthorized: u64 = 2;

public struct Video has key, store {
    id: UID,
    title: String,
    description: String,
    ipfs_hash: String,
    creator: address,
    seal_id: vector<u8>, // Seal 識別 ID (用於加密金鑰)
    key_blob_id: String, // 加密金鑰在 Walrus 上的 Blob ID
}

public struct VideoCreated has copy, drop {
    id: ID,
    title: String,
    creator: address,
}

public entry fun create_video(
    title: String,
    description: String,
    ipfs_hash: String,
    seal_id: vector<u8>,
    key_blob_id: String,
    ctx: &mut TxContext,
) {
    let id = object::new(ctx);
    let video_id = object::uid_to_inner(&id);
    let video = Video {
        id,
        title: title,
        description: description,
        ipfs_hash: ipfs_hash,
        creator: ctx.sender(),
        seal_id: seal_id,
        key_blob_id: key_blob_id,
    };

    event::emit(VideoCreated {
        id: video_id,
        title: video.title,
        creator: video.creator,
    });

    transfer::transfer(video, ctx.sender());
}

public entry fun seal_approve(id: vector<u8>, video: &Video, ctx: &TxContext) {
    // 1. 驗證請求的 ID 是否對應到傳入的 Video 物件中的 seal_id
    assert!(video.seal_id == id, EInvalidId);

    // 2. 驗證發送者是否為影片擁有者 (Creator)
    assert!(video.creator == ctx.sender(), ENotAuthorized);
}
