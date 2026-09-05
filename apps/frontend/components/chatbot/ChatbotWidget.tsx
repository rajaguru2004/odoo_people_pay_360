'use client';

import { useState, useEffect, useRef, memo, useCallback } from 'react';
import { getCompanyTz } from '@/utils/formatters';
import { MessageCircle, X, Send, Sparkles, Loader2, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import axios from '@/lib/axios';

interface Message {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

const ChatbotWidget = memo(function ChatbotWidget() {
    const [isOpen, setIsOpen] = useState(false);
    const [isMinimized, setIsMinimized] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [showSuggestions, setShowSuggestions] = useState(true);
    const [pendingQuery, setPendingQuery] = useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const handleOpenChat = (e: Event) => {
            const customEvent = e as CustomEvent;
            setIsOpen(true);
            setIsMinimized(false);
            if (customEvent.detail?.query) {
                setPendingQuery(customEvent.detail.query);
            }
        };
        window.addEventListener('open-chatbot', handleOpenChat);
        return () => window.removeEventListener('open-chatbot', handleOpenChat);
    }, []);

    useEffect(() => {
        if (isOpen && !isMinimized) {
            fetchSuggestions();
            if (messages.length === 0) {
                // Welcome message
                setMessages([{
                    role: 'assistant',
                    content: '👋 Hello! I am your Ess Portal virtual assistant.\n\nI can help you:\n• Check annual leave\n• View time attendance\n• Look up salary\n• Ask about company policy\n\nWhat do you want to ask?',
                    timestamp: new Date(),
                }]);
            }
        }
    }, [isOpen, isMinimized]);

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const fetchSuggestions = async () => {
        try {
            // Get user info from localStorage
            const userStr = localStorage.getItem('user');
            const user = userStr ? JSON.parse(userStr) : null;
            const role = user?.role || 'EMPLOYEE';

            // Role-based suggestions (3 questions only)
            let roleSuggestions: string[] = [];

            if (role === 'ADMIN') {
                roleSuggestions = [
                    'How many employees are there in the company?',
                    'Which contract is about to expire?',
                    'What is the system status?'
                ];
            } else if (role === 'HR_MANAGER') {
                roleSuggestions = [
                    'Total company salary this month?',
                    'Company-wide timekeeping report',
                    'How many employees?'
                ];
            } else {
                // EMPLOYEE
                roleSuggestions = [
                    'How many days of leave do I have left?',
                    'My attendance this month?',
                    'How much is your salary this month?'
                ];
            }

            setSuggestions(roleSuggestions);
        } catch (error) {
            if (process.env.NODE_ENV === 'development') {
                console.error('Failed to fetch suggestions:', error);
            }
            // Default suggestions for EMPLOYEE
            setSuggestions([
                'How many days of leave do I have left?',
                'My attendance this month?',
                'Regulations on working hours?'
            ]);
        }
    };

    const sendMessage = useCallback(async (text?: string) => {
        const messageText = text || input.trim();
        if (!messageText || loading) return;

        const userMessage: Message = {
            role: 'user',
            content: messageText,
            timestamp: new Date(),
        };

        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setLoading(true);
        setShowSuggestions(false);

        try {
            const response = await axios.post('/chatbot/chat', {
                message: messageText,
                history: messages.slice(-5).map(m => ({
                    role: m.role,
                    content: m.content,
                })),
            }, {
                timeout: 60000, // 60s timeout for LLM fallback mechanism
            });

            // Axios interceptor already unwraps response.data
            // Backend returns: { success: true, data: { message: '...' } }
            const botMessage: Message = {
                role: 'assistant',
                content: response.data.message,
                timestamp: new Date(),
            };

            setMessages(prev => [...prev, botMessage]);
        } catch (error: any) {
            // Only log errors in development
            if (process.env.NODE_ENV === 'development') {
                console.error('Chat error:', error);
                console.error('Error message:', error.message);
            }
            const errorMessage: Message = {
                role: 'assistant',
                content: '❌ Sorry, an error occurred. Please try again later.',
                timestamp: new Date(),
            };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setLoading(false);
        }
    }, [input, loading, messages]);

    useEffect(() => {
        if (pendingQuery && isOpen && !isMinimized && !loading) {
            sendMessage(pendingQuery);
            setPendingQuery('');
        }
    }, [pendingQuery, isOpen, isMinimized, loading, sendMessage]);

    const handleSuggestionClick = useCallback((question: string) => {
        sendMessage(question);
    }, [sendMessage]);

    const handleKeyPress = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    }, [sendMessage]);

    const formatMessage = useCallback((content: string) => {
        // Convert markdown-like formatting to HTML
        return content
            .split('\n')
            .map((line, i) => {
                // Bold text
                line = line.replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold">$1</strong>');
                // Bullet points with blue color
                if (line.trim().startsWith('•')) {
                    const text = line.trim().substring(1).trim();
                    return `<div key=${i} class="flex items-start gap-2 ml-2"><span class="text-brand-primary mt-0.5">•</span><span class="flex-1">${text}</span></div>`;
                }
                return `<div key=${i} class="leading-relaxed">${line || '<br/>'}</div>`; }) .join(''); }, []); return ( <> {/* Chat Button */} <AnimatePresence> {!isOpen && ( <motion.button initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} onClick={() => { setIsOpen(true); setIsMinimized(false); }} className="fixed bottom-24 end-4 md:bottom-6 md:end-6 w-16 h-16 bg-gradient-to-br from-brand-primary to-brand-primary text-white rounded-full shadow-2xl hover:shadow-blue-500/50 hover:scale-110 transition-all z-50 flex items-center justify-center group" > <MessageCircle size={28} className="group-hover:scale-110 transition-transform" /> <span className="absolute -top-1 -end-1 w-4 h-4 bg-green-500 rounded-full border-2 border-white animate-pulse"></span> </motion.button> )} </AnimatePresence> {/* Minimized Chat Header */} <AnimatePresence> {isOpen && isMinimized && ( <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} onClick={() => setIsMinimized(false)} className="fixed bottom-24 inset-x-3 md:inset-x-auto md:bottom-6 md:end-6 w-auto md:w-[380px] bg-gradient-to-r from-brand-primary to-brand-primary p-4 rounded-2xl shadow-2xl z-50 cursor-pointer hover:shadow-blue-500/50 transition-all" > <div className="flex items-center justify-between"> <div className="flex items-center gap-3"> <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center"> <Sparkles size={20} className="text-white" /> </div> <div> <h3 className="text-white font-bold">Ess Portal Assistant</h3> <p className="text-white/80 text-xs">Click to reopen</p> </div> </div> <button onClick={(e) => { e.stopPropagation(); setIsOpen(false); setIsMinimized(false); }} className="text-white/80 hover:text-white hover:bg-white/20 p-2 rounded-lg transition-colors" > <X size={20} /> </button> </div> </motion.div> )} </AnimatePresence> {/* Chat Window */} <AnimatePresence> {isOpen && !isMinimized && ( <motion.div initial={{ opacity: 0, y: 20, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.95 }} className="fixed bottom-20 inset-x-3 top-20 md:inset-x-auto md:top-auto md:bottom-6 md:right-6 w-auto md:w-[380px] h-auto md:h-[550px] bg-white rounded-2xl shadow-2xl z-50 flex flex-col overflow-hidden border border-slate-200" > {/* Header */} <div className="bg-gradient-to-r from-brand-primary to-brand-primary p-4 flex items-center justify-between"> <div className="flex items-center gap-3"> <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center"> <Sparkles size={20} className="text-white" /> </div> <div> <h3 className="text-white font-bold">Ess Portal Assistant</h3> <p className="text-white/80 text-xs">Always ready to assist you</p> </div> </div> <div className="flex items-center gap-2"> <button onClick={() => setIsMinimized(true)} className="text-white/80 hover:text-white hover:bg-white/20 p-2 rounded-lg transition-colors" title="Shrink" > <ChevronDown size={20} /> </button> <button onClick={() => { setIsOpen(false); setIsMinimized(false); }} className="text-white/80 hover:text-white hover:bg-white/20 p-2 rounded-lg transition-colors" title="Close" > <X size={20} /> </button> </div> </div> {/* Messages */} <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50"> {messages.map((message, index) => ( <motion.div key={index} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                                >
                                    <div
                                        className={`max-w-[80%] rounded-2xl px-4 py-3 ${message.role === 'user'
                                            ? 'bg-gradient-to-r from-brand-primary to-brand-primary text-white'
                                            : 'bg-white border border-slate-200 text-slate-700'
                                            }`}
                                    >
                                        <div
                                            className="text-[15px] leading-relaxed whitespace-pre-wrap font-normal"
                                            dangerouslySetInnerHTML={{ __html: formatMessage(message.content) }}
                                        />
                                        <p className={`text-xs mt-2 ${message.role === 'user' ? 'text-white/70' : 'text-slate-400'}`}>
                                            {message.timestamp.toLocaleTimeString('en-IN', { timeZone: getCompanyTz(),  hour: '2-digit', minute: '2-digit' })}
                                        </p>
                                    </div>
                                </motion.div>
                            ))}

                            {loading && (
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    className="flex justify-start"
                                >
                                    <div className="bg-white border border-slate-200 rounded-2xl px-4 py-3 flex items-center gap-2">
                                        <Loader2 size={16} className="animate-spin text-brand-primary" />
                                        <span className="text-sm text-slate-600">Thinking...</span> </div> </motion.div> )} <div ref={messagesEndRef} /> </div> {/* Suggestions */} {showSuggestions && suggestions && suggestions.length > 0 && messages.length <= 1 && ( <div className="border-t border-slate-200 p-3 bg-gradient-to-b from-white to-slate-50">
                                <div className="flex items-center justify-between mb-2">
                                    <p className="text-sm font-semibold text-slate-700">Suggested questions</p> <button onClick={() => setShowSuggestions(false)} className="text-slate-400 hover:text-slate-600 transition-colors"
                                        title="Hide hints"
                                    >
                                        <ChevronDown size={18} />
                                    </button>
                                </div>
                                <div className="flex flex-col gap-2">
                                    {suggestions.map((question, idx) => (
                                        <button
                                            key={idx}
                                            onClick={() => handleSuggestionClick(question)}
                                            className="text-sm px-3 py-2 bg-brand-primary-light/10 text-brand-primary rounded-lg hover:bg-brand-primary hover:text-white transition-all hover:shadow-md font-medium text-left"
                                        >
                                            {question}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Input */}
                        <div className="border-t border-slate-200 p-4 bg-white">
                            <div className="flex items-center gap-2">
                                <input
                                    ref={inputRef}
                                    type="text"
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    onKeyPress={handleKeyPress}
                                    placeholder="Enter your question..."
                                    className="flex-1 px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary text-sm"
                                    disabled={loading}
                                />
                                <button
                                    onClick={() => sendMessage()}
                                    disabled={!input.trim() || loading}
                                    className="p-3 bg-gradient-to-r from-brand-primary to-brand-primary text-white rounded-xl hover:shadow-lg hover:scale-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                                >
                                    <Send size={20} />
                                </button>
                            </div>
                            <p className="text-xs text-slate-400 mt-2 text-center">
                                Press Enter to send • Shift + Enter to get a line break
                            </p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}
);

export default ChatbotWidget;
