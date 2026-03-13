'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { 
  LayoutDashboard, 
  ShoppingBag, 
  Layers, 
  CreditCard,
  ChevronRight,
  Sparkles,
  FileCode,
  Zap,
  ScanSearch,
  GitBranch,
  MessageSquare,
  HelpCircle,
  Wand2,
  FlipVertical,
  Copy,
  Rocket,
  BookOpen,
  ShieldCheck,
  Wand,
} from 'lucide-react';

const menuItems = [
  {
    name: 'Dashboard',
    href: '/',
    icon: LayoutDashboard,
  },
  {
    name: 'Copy Analyzer',
    href: '/copy-analyzer',
    icon: Sparkles,
  },
  {
    name: 'Landing Analyzer',
    href: '/landing-analyzer',
    icon: Zap,
  },
  {
    name: 'Funnel Analyzer',
    href: '/funnel-analyzer',
    icon: ScanSearch,
  },
  {
    name: 'Affiliate Browser Chat',
    href: '/affiliate-browser-chat',
    icon: MessageSquare,
  },
  {
    name: 'My Funnels',
    href: '/my-funnels',
    icon: GitBranch,
  },
  {
    name: 'Reverse Funnel',
    href: '/reverse-funnel',
    icon: FlipVertical,
  },
  {
    name: 'Front End Funnel',
    href: '/front-end-funnel',
    icon: Layers,
  },
  {
    name: 'Post Purchase Funnel',
    href: '/post-purchase',
    icon: CreditCard,
  },
  {
    name: 'My Archive',
    href: '/templates',
    icon: FileCode,
  },
  {
    name: 'My Products',
    href: '/products',
    icon: ShoppingBag,
  },
  {
    name: 'Quiz Creator',
    href: '/quiz-creator',
    icon: Wand2,
  },
  {
    name: 'Swipe Quiz',
    href: '/swipe-quiz',
    icon: HelpCircle,
  },
  {
    name: 'Agentic Swipe',
    href: '/agentic-swipe',
    icon: Wand,
  },
  {
    name: 'Clone & Swipe',
    href: '/clone-landing',
    icon: Copy,
  },
  {
    name: 'My Prompts',
    href: '/prompts',
    icon: BookOpen,
  },
  {
    name: 'Deploy Funnel',
    href: '/deploy-funnel',
    icon: Rocket,
  },
  {
    name: 'Compliance AI',
    href: '/compliance-ai',
    icon: ShieldCheck,
  },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 bg-gray-900 text-white min-h-screen flex flex-col">
      {/* Logo */}
      <div className="p-4 border-b border-gray-800">
        <h1 className="text-base font-bold flex items-center gap-2">
          <Layers className="w-5 h-5 text-blue-400" />
          Funnel Swiper
        </h1>
        <p className="text-gray-400 text-xs mt-0.5">Dashboard Operations</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3">
        <ul className="space-y-1">
          {menuItems.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 truncate">{item.name}</span>
                  {isActive && <ChevronRight className="w-3 h-3 shrink-0" />}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-gray-800 space-y-2">
        <a
          href="/api/health"
          target="_blank"
          rel="noopener noreferrer"
          className="block text-xs text-gray-400 hover:text-amber-400 transition-colors"
        >
          API Diagnostics
        </a>
        <div className="bg-gray-800 rounded-lg p-3">
          <p className="text-xs text-gray-400">Swipe Status</p>
          <div className="flex items-center gap-1.5 mt-1.5">
            <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
            <span className="text-xs">System Active</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
