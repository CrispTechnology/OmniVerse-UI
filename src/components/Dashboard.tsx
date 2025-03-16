import React, { useState, useEffect } from 'react';
import { 
  Bot,
  Settings,
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowRight,
  ImageIcon,
  MessageSquare,
  Lightbulb,
  Code,
  FileText,
  Zap,
  Info
} from 'lucide-react';
import { db } from '../db';
import axios from 'axios';

interface DashboardProps {
  onPageChange?: (page: string) => void;
}

const Dashboard: React.FC<DashboardProps> = ({ onPageChange }) => {
  const [ollamaUrl, setOllamaUrl] = useState('');
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [showOllamaUrlInput, setShowOllamaUrlInput] = useState(false);

  useEffect(() => {
    const loadConfig = async () => {
      const config = await db.getAPIConfig();
      
      if (config?.ollama_base_url) {
        setOllamaUrl(config.ollama_base_url);
        checkOllamaConnection(config.ollama_base_url);
      } else {
        setOllamaStatus('disconnected');
      }
    };
    loadConfig();
  }, []);

  const checkOllamaConnection = async (url: string) => {
    setOllamaStatus('checking');
    
    try {
      const response = await axios.get(`${url}/api/tags`, { timeout: 5000 });
      if (response.status === 200) {
        setOllamaStatus('connected');
      } else {
        setOllamaStatus('disconnected');
      }
    } catch (error) {
      console.error('Ollama connection error:', error);
      setOllamaStatus('disconnected');
    }
  };

  const handleSaveOllamaUrl = async () => {
    setIsConfiguring(true);
    try {
      const config = await db.getAPIConfig();
      await db.updateAPIConfig({
        comfyui_base_url: config?.comfyui_base_url || '',
        ollama_base_url: ollamaUrl
      });
      await checkOllamaConnection(ollamaUrl);
      setShowOllamaUrlInput(false);
    } catch (error) {
      console.error('Error saving Ollama URL:', error);
    } finally {
      setIsConfiguring(false);
    }
  };

  const renderStatusIcon = (status: 'checking' | 'connected' | 'disconnected') => {
    switch (status) {
      case 'checking':
        return <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />;
      case 'connected':
        return <CheckCircle2 className="w-6 h-6 text-green-500" />;
      case 'disconnected':
        return <XCircle className="w-6 h-6 text-red-500" />;
    }
  };

  const showServiceStatus = ollamaStatus === 'disconnected';

  return (
    <div className="h-[calc(100vh-theme(spacing.16)-theme(spacing.12))] overflow-y-auto">
      <div className="max-w-7xl mx-auto p-6 space-y-8">
        {/* Welcome Section */}
        <div className="glassmorphic rounded-2xl p-8 animate-fadeIn">
          <div className="flex items-center gap-4 mb-6">
            <div className="p-4 bg-sakura-100 dark:bg-sakura-100/10 rounded-xl">
              <Bot className="w-8 h-8 text-sakura-500" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-1">
                Welcome to Clara
              </h1>
              <p className="text-gray-600 dark:text-gray-400">
                Your AI assistant powered by Ollama and ComfyUI
              </p>
            </div>
          </div>

          {/* Quick Actions Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Chat Action */}
            <button 
              onClick={() => onPageChange?.('assistant')}
              className="group flex flex-col rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 hover:bg-sakura-50 dark:hover:bg-sakura-100/5 transition-all duration-300 transform hover:-translate-y-1"
            >
              <div className="flex items-center justify-between p-6 pb-2">
                <Bot className="w-6 h-6 text-sakura-500" />
                <ArrowRight className="w-5 h-5 text-gray-400 group-hover:text-sakura-500 transform group-hover:translate-x-1 transition-all" />
              </div>
              <div className="px-6 pb-6 flex-grow">
                <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                  Start Chatting
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Chat with Clara using various AI models through Ollama
                </p>
              </div>
            </button>

            {/* Image Generation Action - Fixed JSX closing tag issue */}
            <button 
              onClick={() => onPageChange?.('image-gen')}
              className="group flex flex-col rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 hover:bg-sakura-50 dark:hover:bg-sakura-100/5 transition-all duration-300 transform hover:-translate-y-1"
            >
              <div className="flex items-center justify-between p-6 pb-2">
                <ImageIcon className="w-6 h-6 text-sakura-500" />
                <ArrowRight className="w-5 h-5 text-gray-400 group-hover:text-sakura-500 transform group-hover:translate-x-1 transition-all" />
              </div>
              <div className="px-6 pb-6 flex-grow">
                <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                  Generate Images
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Create stunning images using Stable Diffusion
                </p>
              </div>
            </button>

            {/* Settings Action */}
            <button 
              onClick={() => onPageChange?.('settings')}
              className="group flex flex-col rounded-xl bg-white/50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 hover:bg-sakura-50 dark:hover:bg-sakura-100/5 transition-all duration-300 transform hover:-translate-y-1"
            >
              <div className="flex items-center justify-between p-6 pb-2">
                <Settings className="w-6 h-6 text-sakura-500" />
                <ArrowRight className="w-5 h-5 text-gray-400 group-hover:text-sakura-500 transform group-hover:translate-x-1 transition-all" />
              </div>
              <div className="px-6 pb-6 flex-grow">
                <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                  Configure Settings
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Customize Clara to match your preferences
                </p>
              </div>
            </button>
          </div>
        </div>

        {/* Service Status Section - Only show if Ollama is disconnected */}
        {showServiceStatus && (
          <div className="glassmorphic rounded-2xl p-8 animate-fadeIn animation-delay-200">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-6">
              Service Status
            </h2>
            
            <div>
              {/* Ollama Status */}
              <div className="p-6 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-4">
                    <div className="p-3 bg-red-100 dark:bg-red-800/30 rounded-lg">
                      <MessageSquare className="w-6 h-6 text-red-500 dark:text-red-400" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                        Ollama Not Connected
                      </h3>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        Chat functionality will be unavailable
                      </p>
                    </div>
                  </div>
                  {renderStatusIcon(ollamaStatus)}
                </div>

                {showOllamaUrlInput ? (
                  <div className="animate-fadeIn">
                    <div className="flex gap-4 mb-4">
                      <input
                        type="url"
                        value={ollamaUrl}
                        onChange={(e) => setOllamaUrl(e.target.value)}
                        placeholder="http://localhost:11434"
                        className="flex-1 px-4 py-2 rounded-lg bg-white/50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 focus:outline-none focus:ring-2 focus:ring-sakura-300"
                      />
                      <button
                        onClick={handleSaveOllamaUrl}
                        disabled={isConfiguring}
                        className="px-6 py-2 bg-sakura-500 text-white rounded-lg hover:bg-sakura-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        {isConfiguring ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          'Save'
                        )}
                      </button>
                    </div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Enter the URL where your Ollama instance is running
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => setShowOllamaUrlInput(true)}
                      className="px-4 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-lg hover:bg-red-200 dark:hover:bg-red-800/30"
                    >
                      Configure Ollama URL
                    </button>
                    {ollamaUrl && (
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        Current URL: {ollamaUrl}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        
        {/* Getting Started Section */}

        
        {/* Capabilities Showcase */}
        <div className="glassmorphic rounded-2xl p-8 animate-fadeIn animation-delay-400">
          <div className="flex items-center gap-4 mb-6">
            <div className="p-4 bg-green-100 dark:bg-green-800/30 rounded-xl">
              <Zap className="w-8 h-8 text-green-500" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-1">
                What You Can Do
              </h2>
              <p className="text-gray-600 dark:text-gray-400">
                Explore Clara's capabilities
              </p>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">
            <div className="bg-white/50 dark:bg-gray-800/50 p-5 rounded-xl border border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3 mb-3">
                <Code className="w-5 h-5 text-indigo-500" />
                <h3 className="font-medium text-gray-900 dark:text-white">Code Assistant</h3>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Ask about coding problems, debug issues, or generate code snippets in multiple languages.
              </p>
            </div>
            
            <div className="bg-white/50 dark:bg-gray-800/50 p-5 rounded-xl border border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3 mb-3">
                <FileText className="w-5 h-5 text-emerald-500" />
                <h3 className="font-medium text-gray-900 dark:text-white">Content Creation</h3>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Generate creative writing, summaries, translations, or professional documents.
              </p>
            </div>
            
            <div className="bg-white/50 dark:bg-gray-800/50 p-5 rounded-xl border border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-3 mb-3">
                <ImageIcon className="w-5 h-5 text-pink-500" />
                <h3 className="font-medium text-gray-900 dark:text-white">Image Generation</h3>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Create custom images with detailed prompts, adjust styles, and explore various artistic effects.
              </p>
            </div>
          </div>
        </div>
        
        {/* Privacy Notice */}
        <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/50 rounded-lg p-4 animate-fadeIn animation-delay-500 flex items-start gap-3">
          <div className="p-2 bg-blue-100 dark:bg-blue-800/30 rounded-full flex-shrink-0 mt-1">
            <Info className="w-4 h-4 text-blue-500" />
          </div>
          <div>
            <h3 className="font-medium text-blue-700 dark:text-blue-300 mb-1">Private & Secure</h3>
            <p className="text-sm text-blue-600/90 dark:text-blue-400/90">
              Clara runs locally on your machine. Your chats, images, and data stay on your device and are never sent to external servers.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;