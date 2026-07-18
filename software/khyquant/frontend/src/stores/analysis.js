/**
 * Pinia store for ML agent analysis results
 * Bridges SmartTrading agent panel -> AI chat context
 */
import { defineStore } from 'pinia'

export const useAnalysisStore = defineStore('analysis', {
  state: () => ({
    // Latest agent analysis results keyed by stock code
    currentStockCode: '',
    agentResults: [],       // Array of { agentId, agentName, model, score, analysis, keyFindings, confidence }
    recommendation: '',     // 'buy' | 'sell' | 'hold'
    confidence: 0,          // 0-100
    summary: '',
    timestamp: null,
    // Conversation history for context window
    conversationHistory: [] // Array of { role: 'user'|'assistant', content, timestamp }
  }),

  getters: {
    hasResults: (state) => state.agentResults.length > 0,
    contextForChat: (state) => ({
      stockCode: state.currentStockCode,
      agentResults: state.agentResults,
      recommendation: state.recommendation,
      confidence: state.confidence,
      summary: state.summary
    })
  },

  actions: {
    /**
     * Store agent analysis results from SmartTrading page
     */
    setAnalysisResults({ stockCode, agents, recommendation, confidence, summary }) {
      this.currentStockCode = stockCode
      this.agentResults = agents || []
      this.recommendation = recommendation || 'hold'
      this.confidence = confidence || 0
      this.summary = summary || ''
      this.timestamp = Date.now()
    },

    /**
     * Add a message to conversation history (sliding window of 20)
     */
    addMessage(role, content) {
      this.conversationHistory.push({ role, content, timestamp: Date.now() })
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20)
      }
    },

    clearHistory() {
      this.conversationHistory = []
    },

    clear() {
      this.currentStockCode = ''
      this.agentResults = []
      this.recommendation = ''
      this.confidence = 0
      this.summary = ''
      this.timestamp = null
      this.conversationHistory = []
    }
  }
})
