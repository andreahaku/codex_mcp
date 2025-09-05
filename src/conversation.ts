import { 
  Conversation, 
  ConversationMessage
} from './types.js';

export class ConversationManager {
  private conversations: Map<string, Conversation> = new Map();
  private maxConversations: number;
  private maxMessagesPerConversation: number;

  constructor(
    maxConversations = 50,
    maxMessagesPerConversation = 100
  ) {
    this.maxConversations = maxConversations;
    this.maxMessagesPerConversation = maxMessagesPerConversation;
  }

  startConversation(topic: string, instructions?: string): string {
    // Clean up if we're at max capacity
    if (this.conversations.size >= this.maxConversations) {
      this.cleanupOldestConversation();
    }

    const id = this.generateId();
    const messages: ConversationMessage[] = [];

    // Add initial developer instructions if provided
    if (instructions) {
      messages.push({
        role: 'developer',
        content: instructions,
        timestamp: new Date()
      });
    }

    const conversation: Conversation = {
      id,
      messages,
      metadata: {
        created: new Date(),
        lastActive: new Date(),
        topic
      }
    };

    this.conversations.set(id, conversation);
    return id;
  }

  addMessage(
    conversationId: string, 
    role: 'user' | 'assistant' | 'developer', 
    content: string
  ): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // Trim old messages if necessary
    if (conversation.messages.length >= this.maxMessagesPerConversation) {
      // Keep the first message if it's developer instructions
      const keepFirst = conversation.messages[0]?.role === 'developer';
      if (keepFirst) {
        conversation.messages = [
          conversation.messages[0],
          ...conversation.messages.slice(-(this.maxMessagesPerConversation - 2))
        ];
      } else {
        conversation.messages = conversation.messages.slice(-(this.maxMessagesPerConversation - 1));
      }
    }

    conversation.messages.push({
      role,
      content,
      timestamp: new Date()
    });

    conversation.metadata.lastActive = new Date();
  }

  getConversation(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  getContext(conversationId: string, maxMessages = 10): ConversationMessage[] {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // Always include developer instructions if present
    const hasDevInstructions = conversation.messages[0]?.role === 'developer';
    
    if (hasDevInstructions && maxMessages > 1) {
      const recentMessages = conversation.messages.slice(-(maxMessages - 1));
      return [conversation.messages[0], ...recentMessages];
    }

    return conversation.messages.slice(-maxMessages);
  }

  formatForAPI(conversationId: string, newMessage?: string, maxMessages?: number): any[] {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const messages: any[] = [];

    // Determine context window size
    const contextLimit = typeof maxMessages === 'number'
      ? Math.max(1, maxMessages)
      : (conversation.metadata.contextLimit || parseInt(process.env.MAX_CONVERSATION_CONTEXT || '10'));

    // Convert conversation messages to API format
    const sourceMessages = conversation.messages.slice(-contextLimit);
    for (const msg of sourceMessages) {
      if (msg.role === 'developer') {
        // Developer messages become part of instructions
        continue;
      }
      
      messages.push({
        role: msg.role,
        content: msg.content
      });
    }

    // Add new message if provided
    if (newMessage) {
      messages.push({
        role: 'user',
        content: newMessage
      });
    }

    return messages;
  }

  getInstructions(conversationId: string): string | undefined {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return undefined;
    }

    // Return developer instructions if present
    const firstMessage = conversation.messages[0];
    if (firstMessage?.role === 'developer') {
      return firstMessage.content;
    }

    return undefined;
  }

  setOptions(conversationId: string, options: Partial<{ contextLimit: number }>): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    if (typeof options.contextLimit === 'number') {
      conversation.metadata.contextLimit = Math.max(1, Math.floor(options.contextLimit));
    }
    conversation.metadata.lastActive = new Date();
  }

  getMetadata(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  listConversations(): Array<{ id: string; topic?: string; created: Date; lastActive: Date }> {
    return Array.from(this.conversations.values())
      .map(conv => ({
        id: conv.id,
        topic: conv.metadata.topic,
        created: conv.metadata.created,
        lastActive: conv.metadata.lastActive
      }))
      .sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
  }

  deleteConversation(conversationId: string): boolean {
    return this.conversations.delete(conversationId);
  }

  clearAll(): void {
    this.conversations.clear();
  }

  getStats(): {
    totalConversations: number;
    totalMessages: number;
  } {
    let totalMessages = 0;

    for (const conv of this.conversations.values()) {
      totalMessages += conv.messages.length;
    }

    return {
      totalConversations: this.conversations.size,
      totalMessages
    };
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 9);
    return `conv_${timestamp}_${random}`;
  }

  private cleanupOldestConversation(): void {
    let oldest: Conversation | null = null;
    let oldestId: string | null = null;

    for (const [id, conv] of this.conversations.entries()) {
      if (!oldest || conv.metadata.lastActive < oldest.metadata.lastActive) {
        oldest = conv;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.conversations.delete(oldestId);
    }
  }

  exportConversation(conversationId: string): string {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    return JSON.stringify(conversation, null, 2);
  }

  importConversation(data: string): string {
    try {
      const conversation = JSON.parse(data);
      
      // Convert timestamp strings back to Date objects
      conversation.messages = conversation.messages.map((msg: any) => ({
        ...msg,
        timestamp: new Date(msg.timestamp)
      }));
      
      conversation.metadata.created = new Date(conversation.metadata.created);
      conversation.metadata.lastActive = new Date(conversation.metadata.lastActive);

      // Generate new ID to avoid conflicts
      const newId = this.generateId();
      conversation.id = newId;

      this.conversations.set(newId, conversation);
      return newId;
    } catch (error) {
      throw new Error(`Failed to import conversation: ${error}`);
    }
  }
}