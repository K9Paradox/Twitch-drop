/**
 * Realistic Twitch GraphQL Query & Mutation response fixtures
 */

export const currentUserFixture = {
    data: {
        currentUser: {
            id: "12345678",
            login: "dropfarmer",
            displayName: "DropFarmer",
            profileImageURL: "https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb9e-91fbe85943c7-profile_image-300x300.png"
        }
    }
};

export const directoryRootFixture = {
    data: {
        game: {
            id: "515025",
            name: "Overwatch 2",
            displayName: "Overwatch 2",
            boxArtURL: "https://static-cdn.jtvnw.net/ttv-boxart/515025-285x380.jpg"
        }
    }
};

export const viewerDropsDashboardFixture = {
    data: {
        currentUser: {
            dropCampaigns: [
                {
                    id: "camp-ow-1",
                    name: "Overwatch 2 Season 10 Drops",
                    status: "ACTIVE",
                    game: {
                        id: "515025",
                        name: "Overwatch 2",
                        displayName: "Overwatch 2",
                        boxArtURL: "https://static-cdn.jtvnw.net/ttv-boxart/515025-285x380.jpg"
                    },
                    startAt: "2026-08-01T00:00:00Z",
                    endAt: "2026-10-30T23:59:59Z",
                    timeBasedDrops: [
                        {
                            id: "drop-ow-1",
                            name: "Kiriko Skin",
                            requiredMinutesWatched: 120,
                            benefitEdges: [
                                {
                                    benefit: {
                                        id: "ben-ow-1",
                                        name: "Kiriko Mythic Skin",
                                        imageAssetURL: "https://static-cdn.jtvnw.net/drops/kiriko.png"
                                    }
                                }
                            ],
                            self: {
                                isClaimed: false,
                                currentMinutesWatched: 45,
                                dropInstanceID: "inst-ow-1"
                            }
                        },
                        {
                            id: "drop-ow-2",
                            name: "Kiriko Voice Line",
                            requiredMinutesWatched: 60,
                            benefitEdges: [
                                {
                                    benefit: {
                                        id: "ben-ow-2",
                                        name: "Voice Line",
                                        imageAssetURL: "https://static-cdn.jtvnw.net/drops/voiceline.png"
                                    }
                                }
                            ],
                            self: {
                                isClaimed: true,
                                currentMinutesWatched: 60,
                                dropInstanceID: "inst-ow-2"
                            }
                        }
                    ]
                }
            ]
        },
        rewardCampaignsAvailableToUser: [
            {
                id: "camp-val-1",
                name: "Valorant Champions 2026",
                status: "ACTIVE",
                game: {
                    id: "516575",
                    name: "Valorant",
                    displayName: "Valorant",
                    boxArtURL: "https://static-cdn.jtvnw.net/ttv-boxart/516575-285x380.jpg"
                },
                startAt: "2026-08-10T00:00:00Z",
                endAt: "2026-08-25T23:59:59Z",
                timeBasedDrops: [
                    {
                        id: "drop-val-1",
                        name: "Champions Gun Buddy",
                        requiredMinutesWatched: 60,
                        benefitEdges: [
                            {
                                benefit: {
                                    id: "ben-val-1",
                                    name: "Gun Buddy",
                                    imageAssetURL: "https://static-cdn.jtvnw.net/drops/buddy.png"
                                }
                            }
                        ],
                        self: {
                            isClaimed: false,
                            currentMinutesWatched: 30,
                            dropInstanceID: "inst-val-1"
                        }
                    }
                ]
            }
        ]
    }
};

export const dropCampaignDetailsFixture = {
    data: {
        user: {
            dropCampaign: {
                id: "camp-ow-1",
                name: "Overwatch 2 Season 10 Drops",
                status: "ACTIVE",
                game: {
                    id: "515025",
                    name: "Overwatch 2",
                    displayName: "Overwatch 2"
                },
                timeBasedDrops: [
                    {
                        id: "drop-ow-1",
                        name: "Kiriko Skin",
                        requiredMinutesWatched: 120,
                        benefitEdges: [
                            {
                                benefit: {
                                    id: "ben-ow-1",
                                    name: "Kiriko Mythic Skin",
                                    imageAssetURL: "https://static-cdn.jtvnw.net/drops/kiriko.png"
                                }
                            }
                        ],
                        self: {
                            isClaimed: false,
                            currentMinutesWatched: 45,
                            dropInstanceID: "inst-ow-1"
                        }
                    }
                ]
            }
        }
    }
};

export const inventoryFixture = {
    data: {
        currentUser: {
            inventory: {
                dropCampaignsInProgress: [
                    {
                        id: "camp-ow-1",
                        name: "Overwatch 2 Season 10 Drops",
                        game: {
                            id: "515025",
                            name: "Overwatch 2",
                            displayName: "Overwatch 2"
                        },
                        status: "ACTIVE",
                        timeBasedDrops: [
                            {
                                id: "drop-ow-1",
                                name: "Kiriko Skin",
                                requiredMinutesWatched: 120,
                                benefitEdges: [
                                    {
                                        benefit: {
                                            id: "ben-ow-1",
                                            name: "Kiriko Mythic Skin",
                                            imageAssetURL: "https://static-cdn.jtvnw.net/drops/kiriko.png"
                                        }
                                    }
                                ],
                                self: {
                                    isClaimed: false,
                                    currentMinutesWatched: 45,
                                    dropInstanceID: "inst-ow-1"
                                }
                            },
                            {
                                id: "drop-ow-2",
                                name: "Kiriko Voice Line",
                                requiredMinutesWatched: 60,
                                benefitEdges: [
                                    {
                                        benefit: {
                                            id: "ben-ow-2",
                                            name: "Voice Line",
                                            imageAssetURL: "https://static-cdn.jtvnw.net/drops/voiceline.png"
                                        }
                                    }
                                ],
                                self: {
                                    isClaimed: true,
                                    currentMinutesWatched: 60,
                                    dropInstanceID: "inst-ow-2"
                                }
                            }
                        ]
                    }
                ],
                gameEventDrops: [
                    {
                        id: "drop-val-1",
                        benefitId: "ben-val-1",
                        name: "Champions Gun Buddy",
                        game: {
                            id: "516575",
                            name: "Valorant"
                        },
                        lastAwardedAt: "2026-08-14T12:00:00Z"
                    }
                ]
            }
        }
    }
};

export const directoryPageGameFixture = {
    data: {
        game: {
            id: "515025",
            name: "Overwatch 2",
            displayName: "Overwatch 2",
            streams: {
                edges: [
                    {
                        node: {
                            id: "stream-101",
                            broadcaster: {
                                id: "user-101",
                                login: "superstreamer",
                                displayName: "SuperStreamer"
                            },
                            viewersCount: 12500,
                            title: "[DROPS ENABLED] Grinding Top 500 Overwatch 2",
                            game: {
                                id: "515025",
                                name: "Overwatch 2",
                                displayName: "Overwatch 2"
                            }
                        }
                    },
                    {
                        node: {
                            id: "stream-102",
                            broadcaster: {
                                id: "user-102",
                                login: "chillgamer",
                                displayName: "ChillGamer"
                            },
                            viewersCount: 4200,
                            title: "Chill ranked games !drops",
                            game: {
                                id: "515025",
                                name: "Overwatch 2",
                                displayName: "Overwatch 2"
                            }
                        }
                    },
                    {
                        node: {
                            id: "stream-103",
                            broadcaster: {
                                id: "user-103",
                                login: "pro_support",
                                displayName: "Pro_Support"
                            },
                            viewersCount: 1800,
                            title: "Support to GM !drops",
                            game: {
                                id: "515025",
                                name: "Overwatch 2",
                                displayName: "Overwatch 2"
                            }
                        }
                    }
                ]
            }
        }
    }
};

export const claimDropRewardSuccessFixture = {
    data: {
        claimDropReward: {
            status: "SUCCESS",
            dropInstanceID: "inst-ow-1"
        }
    }
};

export const claimDropRewardEligibleFixture = {
    data: {
        claimDropReward: {
            status: "ELIGIBLE_FOR_CLAIM",
            dropInstanceID: "inst-ow-1"
        }
    }
};

export const claimCommunityPointsSuccessFixture = {
    data: {
        claimCommunityPoints: {
            claim: {
                id: "chest-claim-100",
                pointsEarnedTotal: 50,
                channel: {
                    id: "user-101",
                    login: "superstreamer"
                }
            },
            error: null
        }
    }
};

export const claimCommunityPointsErrorFixture = {
    data: {
        claimCommunityPoints: {
            claim: null,
            error: {
                code: "CLAIM_NOT_FOUND",
                message: "This channel points bonus has already been claimed or expired."
            }
        }
    }
};

export const channelShellLiveFixture = {
    data: {
        userOrError: {
            __typename: "User",
            id: "user-101",
            login: "superstreamer",
            displayName: "SuperStreamer",
            stream: {
                id: "stream-101",
                type: "live",
                viewersCount: 12500,
                title: "[DROPS ENABLED] Grinding Top 500 Overwatch 2",
                game: {
                    id: "515025",
                    name: "Overwatch 2",
                    displayName: "Overwatch 2"
                },
                createdAt: "2026-08-14T20:00:00Z"
            }
        }
    }
};

export const channelShellOfflineFixture = {
    data: {
        userOrError: {
            __typename: "User",
            id: "user-101",
            login: "superstreamer",
            displayName: "SuperStreamer",
            stream: null
        }
    }
};
