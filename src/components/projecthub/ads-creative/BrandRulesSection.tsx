'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Loader2, Save, Shield } from 'lucide-react';
import type { BrandRules } from '@/lib/ads-intel/brain';
import { EMPTY_BRAND_RULES } from '@/lib/ads-intel/brain';

function linesToList(s: string): string[] {
  return s
    .split(/\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function listToLines(xs: string[]): string {
  return (xs || []).join('\n');
}

export function BrandRulesSection({ projectId }: { projectId: string }) {
  const [rules, setRules] = useState<BrandRules>(EMPTY_BRAND_RULES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/brand-rules`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load brand rules');
      setRules(data.brand_rules || EMPTY_BRAND_RULES);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/projecthub/projects/${projectId}/brand-rules`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_rules: rules }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setRules(data.brand_rules);
      toast.success('Brand rules saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading brand rules…
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1 flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" /> Brand rules
        </h2>
        <p className="text-sm text-muted-foreground">
          Positioning, tone, palette names, and hard constraints used when analyzing ads and generating creatives.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="positioning">Positioning</Label>
          <Textarea
            id="positioning"
            value={rules.positioning}
            onChange={(e) => setRules((r) => ({ ...r, positioning: e.target.value }))}
            rows={3}
            placeholder="Who you are for, and the category frame"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="tone">Tone of voice</Label>
          <Input
            id="tone"
            value={rules.tone}
            onChange={(e) => setRules((r) => ({ ...r, tone: e.target.value }))}
            placeholder="e.g. Direct, clinical, no hype"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="palette">Palette (colour names, one per line)</Label>
          <Textarea
            id="palette"
            value={listToLines(rules.palette)}
            onChange={(e) => setRules((r) => ({ ...r, palette: linesToList(e.target.value) }))}
            rows={3}
            placeholder={"Forest green\nWarm cream\nCharcoal"}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="logo_rules">Logo rules</Label>
          <Textarea
            id="logo_rules"
            value={rules.logo_rules}
            onChange={(e) => setRules((r) => ({ ...r, logo_rules: e.target.value }))}
            rows={2}
            placeholder="When and how the logo must appear"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="forbidden">Forbidden (one per line)</Label>
          <Textarea
            id="forbidden"
            value={listToLines(rules.forbidden)}
            onChange={(e) => setRules((r) => ({ ...r, forbidden: linesToList(e.target.value) }))}
            rows={4}
            placeholder={"Guaranteed results\nBefore/after medical claims"}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="required">Required elements (one per line)</Label>
          <Textarea
            id="required"
            value={listToLines(rules.required_elements)}
            onChange={(e) =>
              setRules((r) => ({ ...r, required_elements: linesToList(e.target.value) }))
            }
            rows={3}
            placeholder={"Disclaimer\nBrand mark"}
          />
        </div>
      </div>

      <Button onClick={() => void save()} disabled={saving} className="gap-2">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        Save brand rules
      </Button>
    </div>
  );
}
