'use client';

import { useState } from 'react';
import Header from '@/components/Header';
import { Swords } from 'lucide-react';

export default function ProtocolloValchiriaPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="p-2.5 bg-gradient-to-br from-purple-600 to-red-600 rounded-xl shadow-lg">
            <Swords className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Protocollo Valchiria</h1>
            <p className="text-gray-500 text-sm">Strategic operations center</p>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center">
          <Swords className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500 text-lg font-medium">Sezione pronta</p>
          <p className="text-gray-400 text-sm mt-1">In attesa di istruzioni...</p>
        </div>
      </main>
    </div>
  );
}
