'use client';

export default function Error({ error }: { error: Error }) {
  return (
    <div className="min-h-screen bg-white p-10">
      <div className="max-w-2xl mx-auto bg-red-50 border border-red-200 rounded-xl p-6">
        <h2 className="text-red-700 text-xl font-bold mb-4">Error Detail</h2>
        <pre className="text-red-800 text-sm whitespace-pre-wrap break-all">
          {error.message}
          {'\n\n'}
          {error.stack}
        </pre>
      </div>
    </div>
  );
}
