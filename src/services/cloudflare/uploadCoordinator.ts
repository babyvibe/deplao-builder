/**
 * uploadCoordinator: coordinates the upload path to R2 between the Cloudflare modules.
 *
 * The DB base snapshot is one big file (several hundred MB) that must go up in full. If media storage uploads several files at the same time, both compete for bandwidth, and the base snapshot's parts easily time out and have to be sent again. While the DB base snapshot is uploading, media storage runs 1 file only.
 */
let dbBaseUploads = 0;

/** Called when a DB base snapshot upload starts; returns an end function (calling it several times still counts once). */
export function beginDbBaseUpload(): () => void {
    dbBaseUploads++;
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        dbBaseUploads = Math.max(0, dbBaseUploads - 1);
    };
}

/** A DB base snapshot is being uploaded to R2. */
export function dbBaseUploadActive(): boolean {
    return dbBaseUploads > 0;
}
