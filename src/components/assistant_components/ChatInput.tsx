import React, { useRef } from 'react';
import { Send, Image as ImageIcon, Paperclip, Mic, Loader2, Plus, X, Square } from 'lucide-react';

interface ChatInputProps {
  input: string;
  setInput: (input: string) => void;
  handleSend: () => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  isDisabled: boolean;
  isProcessing: boolean;
  onNewChat: () => void;
  onImageUpload?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  images: Array<{ id: string; preview: string }>;
  onRemoveImage: (id: string) => void;
  handleStopStreaming: () => void;
}

const ChatInput: React.FC<ChatInputProps> = ({
  input,
  setInput,
  handleSend,
  handleKeyDown,
  isDisabled,
  isProcessing,
  onNewChat,
  onImageUpload,
  images,
  onRemoveImage,
  handleStopStreaming
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const handleImageClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="p-6 flex justify-center">
      {/* New Chat Button - Left Side */}
      <div className="mr-4">
        <button
          onClick={onNewChat}
          className="group p-3 rounded-xl bg-white hover:bg-sakura-50 dark:bg-sakura-500 dark:hover:bg-sakura-600 text-sakura-500 dark:text-white transition-all relative border border-sakura-200 dark:border-transparent shadow-md hover:shadow-lg"
          title="New Chat"
        >
          <Plus className="w-6 h-6" />
          <span className="absolute left-1/2 -translate-x-1/2 -top-8 px-2 py-1 bg-gray-900 dark:bg-gray-700 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
            New Chat
          </span>
        </button>
      </div>

      {/* Main Input Container */}
      <div className="flex-1 max-w-3xl">
        <div className="glassmorphic rounded-xl p-4">
          {/* Images Preview */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {images.map((image) => (
                <div 
                  key={image.id} 
                  className="relative group w-16 h-16 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700"
                >
                  <img 
                    src={image.preview} 
                    alt="Uploaded" 
                    className="w-full h-full object-cover"
                  />
                  <button
                    onClick={() => onRemoveImage(image.id)}
                    className="absolute top-1 right-1 p-1 rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input Field */}
          <div className="mb-4">
            <textarea
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask me anything..."
              className="w-full bg-transparent border-0 outline-none focus:outline-none focus:ring-0 resize-none text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-500"
              style={{
                height: 'auto',
                minHeight: '24px',
                maxHeight: '250px',
                overflowY: 'auto'
              }}
              disabled={isProcessing && !input}
            />
          </div>

          {/* Bottom Actions */}
          <div className="flex justify-between items-center">
            {/* Left Side Actions */}
            <div className="flex items-center gap-2">
              <button 
                className="group p-2 rounded-lg hover:bg-sakura-50 dark:hover:bg-sakura-100/5 text-gray-600 dark:text-gray-400 transition-colors relative"
                onClick={handleImageClick}
                disabled={isProcessing}
              >
                <ImageIcon className="w-5 h-5" />
                <span className="absolute left-1/2 -translate-x-1/2 -top-8 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                  Add Image
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={onImageUpload}
                className="hidden"
              />
              <button 
                className="group p-2 rounded-lg hover:bg-sakura-50 dark:hover:bg-sakura-100/5 text-gray-600 dark:text-gray-400 transition-colors relative"
                disabled={isProcessing}
              >
                <Paperclip className="w-5 h-5" />
                <span className="absolute left-1/2 -translate-x-1/2 -top-8 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                  Attach File
                </span>
              </button>
              <button 
                className="group p-2 rounded-lg hover:bg-sakura-50 dark:hover:bg-sakura-100/5 text-gray-600 dark:text-gray-400 transition-colors relative"
                disabled={isProcessing}
              >
                <Mic className="w-5 h-5" />
                <span className="absolute left-1/2 -translate-x-1/2 -top-8 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                  Voice Input
                </span>
              </button>
            </div>

            {/* Right Side Send Button */}
            {isProcessing ? (
              <button
                onClick={handleStopStreaming}
                className="p-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors flex items-center gap-1"
                title="Stop generating"
              >
                <Square className="w-4 h-4" fill="white" />
                <Loader2 className="w-4 h-4 animate-spin" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={isDisabled}
                className="p-2 rounded-lg bg-sakura-500 text-white hover:bg-sakura-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Send className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatInput;