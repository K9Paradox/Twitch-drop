/**
 * Realistic Twitch WebSocket (Hermes & PubSub) message fixtures
 */

export function createHermesPointsEarned(totalPoints = 50, channelId = "user-101") {
    return JSON.stringify({
        type: "MESSAGE",
        data: {
            topic: `community-points-user-v1.${channelId}`,
            message: JSON.stringify({
                type: "points-earned",
                data: {
                    timestamp: new Date().toISOString(),
                    channel_id: channelId,
                    point_gain: {
                        total_points: totalPoints,
                        baseline_points: 10,
                        reason_code: "WATCH_STREAK"
                    },
                    balance: {
                        points: 1540
                    }
                }
            })
        }
    });
}

export function createHermesClaimAvailable(claimId = "chest-claim-100", channelId = "user-101") {
    return JSON.stringify({
        type: "MESSAGE",
        data: {
            topic: `community-points-user-v1.${channelId}`,
            message: JSON.stringify({
                type: "claim-available",
                data: {
                    claim: {
                        id: claimId,
                        channel_id: channelId,
                        created_at: new Date().toISOString()
                    }
                }
            })
        }
    });
}

export function createHermesDropProgress(dropId = "drop-ow-1", currentMinutes = 60, requiredMinutes = 120) {
    return JSON.stringify({
        type: "MESSAGE",
        data: {
            topic: "user-drop-events",
            message: JSON.stringify({
                type: "drop-progress",
                data: {
                    drop_id: dropId,
                    current_progress_min: currentMinutes,
                    required_progress_min: requiredMinutes
                }
            })
        }
    });
}

export function createPubSubMessage(topic, messageObj) {
    return JSON.stringify({
        type: "MESSAGE",
        data: {
            topic: topic,
            message: typeof messageObj === "string" ? messageObj : JSON.stringify(messageObj)
        }
    });
}

export const hermesPointsEarnedFixture = createHermesPointsEarned(50, "user-101");
export const hermesClaimAvailableFixture = createHermesClaimAvailable("chest-claim-100", "user-101");
export const hermesDropProgressFixture = createHermesDropProgress("drop-ow-1", 60, 120);
