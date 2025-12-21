module sui_stream::video_platform;

use std::string::String;
use sui::event;

public struct Video has key, store {
    id: UID,
    title: String,
    description: String,
    ipfs_hash: String,
    creator: address,
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
    };

    event::emit(VideoCreated {
        id: video_id,
        title: video.title,
        creator: video.creator,
    });

    transfer::transfer(video, ctx.sender());
}
