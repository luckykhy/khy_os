/**
 * Legacy compatibility entry.
 *
 * This file used to hold a separate WebSocket client implementation.
 * It now forwards to the unified singleton to guarantee a single frontend
 * WebSocket connection even if old imports are still present.
 */
import websocketService from './websocketService'

export default websocketService
