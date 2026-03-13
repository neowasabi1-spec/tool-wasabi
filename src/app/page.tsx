'use client';

import Header from '@/components/Header';
import { useStore } from '@/store/useStore';
import { 
  Layers, 
  ShoppingBag, 
  CheckCircle, 
  Clock, 
  TrendingUp 
} from 'lucide-react';
import Link from 'next/link';

export default function Dashboard() {
  const { products, funnelPages, postPurchasePages } = useStore();

  const stats = [
    {
      name: 'Total Products',
      value: products.length,
      icon: ShoppingBag,
      color: 'bg-blue-500',
      href: '/products',
    },
    {
      name: 'Front End Pages',
      value: funnelPages.length,
      icon: Layers,
      color: 'bg-purple-500',
      href: '/front-end-funnel',
    },
    {
      name: 'Swipes Completed',
      value: [...funnelPages, ...postPurchasePages].filter(
        (p) => p.swipeStatus === 'completed'
      ).length,
      icon: CheckCircle,
      color: 'bg-green-500',
      href: '#',
    },
    {
      name: 'Pending',
      value: [...funnelPages, ...postPurchasePages].filter(
        (p) => p.swipeStatus === 'pending'
      ).length,
      icon: Clock,
      color: 'bg-yellow-500',
      href: '#',
    },
  ];

  return (
    <div className="min-h-screen">
      <Header title="Dashboard" subtitle="Overview of swipe activities" />

      <div className="p-6">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <Link
                key={stat.name}
                href={stat.href}
                className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-gray-500 text-sm">{stat.name}</p>
                    <p className="text-3xl font-bold text-gray-900 mt-2">
                      {stat.value}
                    </p>
                  </div>
                  <div className={`${stat.color} p-3 rounded-lg`}>
                    <Icon className="w-6 h-6 text-white" />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Link
            href="/front-end-funnel"
            className="bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-xl p-6 hover:from-blue-700 hover:to-blue-800 transition-colors"
          >
            <div className="flex items-center gap-4">
              <Layers className="w-12 h-12" />
              <div>
                <h3 className="text-xl font-bold">Front End Funnel</h3>
                <p className="text-blue-100 mt-1">
                  Manage landing pages, quizzes, checkouts and more
                </p>
              </div>
            </div>
          </Link>

          <Link
            href="/post-purchase"
            className="bg-gradient-to-r from-purple-600 to-purple-700 text-white rounded-xl p-6 hover:from-purple-700 hover:to-purple-800 transition-colors"
          >
            <div className="flex items-center gap-4">
              <TrendingUp className="w-12 h-12" />
              <div>
                <h3 className="text-xl font-bold">Post Purchase Funnel</h3>
                <p className="text-purple-100 mt-1">
                  Manage upsells, downsells and thank you pages
                </p>
              </div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
