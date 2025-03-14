import  { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import Dashboard from './components/Dashboard';
import Settings from './components/Settings';
import Debug from './components/Debug';
import Assistant from './components/Assistant';
import Onboarding from './components/Onboarding';
import { db } from './db';
import Apps from './components/Apps';
import AppCreator from './components/AppCreator';
import AppRunner from './components/AppRunner';
import NodeRegistryDebug from './debug/NodeRegistryDebug'; 
import ToolbarDebug from './debug/ToolbarDebug';
import ImageGen from './components/ImageGen';
import { ImageGenProvider } from './context/ImageGenContext';

function App() {
  const [activePage, setActivePage] = useState('dashboard');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [userInfo, setUserInfo] = useState<{ name: string } | null>(null);

  useEffect(() => {
    const checkUserInfo = async () => {
      const info = await db.getPersonalInfo();
      if (!info || !info.name) {
        setShowOnboarding(true);
      } else {
        setShowOnboarding(false);
        setUserInfo({ name: info.name });
      }
    };
    checkUserInfo();
  }, []);

  const handleOnboardingComplete = async () => {
    setShowOnboarding(false);
    const info = await db.getPersonalInfo();
    if (info) {
      setUserInfo({ name: info.name });
    }
  };
  
  // Get app ID from localStorage when opening app pages
  useEffect(() => {
    if (activePage === 'app-creator' || activePage === 'app-runner') {
      const appId = localStorage.getItem('current_app_id');
      
      // For app-creator, we allow null/undefined appIds (creating new app)
      if (activePage === 'app-runner' && !appId) {
        // We need an app ID to run an app
        setActivePage('apps');
      }
    }
  }, [activePage]);

  const renderContent = () => {
    if (activePage === 'assistant') {
      return <Assistant onPageChange={setActivePage} />;
    }
    
    if (activePage === 'app-creator') {
      const appId = localStorage.getItem('current_app_id');
      // Note: appId can be null here (for creating a new app)
      return <AppCreator onPageChange={setActivePage} appId={appId || undefined} />;
    }
    
    if (activePage === 'app-runner') {
      const appId = localStorage.getItem('current_app_id');
      // If we have an app ID, render the AppRunner, otherwise go back to apps
      if (appId) {
        return <AppRunner appId={appId} onBack={() => setActivePage('apps')} />;
      } else {
        setActivePage('apps');
        return null;
      }
    }

    return (
      <div className="flex h-screen">
        <Sidebar activePage={activePage} onPageChange={setActivePage} />
        
        <div className="flex-1 flex flex-col">
          <Topbar userName={userInfo?.name} onPageChange={setActivePage} />
          
          <main className="flex-1 p-6 overflow-auto">
            {(() => {
              switch (activePage) {
                case 'settings':
                  return <Settings />;
                case 'debug':
                  return <Debug />;
                case 'apps':
                  return <Apps onPageChange={setActivePage} />;
                case 'imageGen':
                  return (
                    <ImageGenProvider>
                      <ImageGen />
                    </ImageGenProvider>
                  );
                case 'dashboard':
                default:
                  return <Dashboard onPageChange={setActivePage} />;
              }
            })()}
            {import.meta.env.DEV && (
              <>
                <NodeRegistryDebug />
                <ToolbarDebug />
              </>
            )}
          </main>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-white to-sakura-100 dark:from-gray-900 dark:to-sakura-100">
      {showOnboarding ? (
        <Onboarding onComplete={handleOnboardingComplete} />
      ) : (
        renderContent()
      )}
    </div>
  );
}

export default App;