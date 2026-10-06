import React, { useState, useEffect } from 'react';
import { Sprout, Plus, Users } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

type Seed = { name: string; at: number };

// A small app in the shape Claude artifacts take: hooks, TypeScript, lucide icons, shadcn/ui, Tailwind,
// and Claude's window.storage (personal and shared).
export default function SeedSwap() {
  const [mine, setMine] = useState<Seed[]>([]);
  const [garden, setGarden] = useState<Seed[]>([]);
  const [name, setName] = useState('');
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    (async () => {
      try {
        const p = await window.storage.get('my-seeds');
        if (p) setMine(JSON.parse(p.value));
        const s = await window.storage.get('garden', true);
        if (s) setGarden(JSON.parse(s.value));
        setStatus('ready');
      } catch (e) {
        setStatus('error: ' + e.message);
      }
    })();
  }, []);

  const plant = async () => {
    if (!name.trim()) return;
    const seed: Seed = { name: name.trim(), at: Date.now() };
    const nextMine = [...mine, seed];
    const nextGarden = [...garden, seed];
    setMine(nextMine);
    setGarden(nextGarden);
    setName('');
    await window.storage.set('my-seeds', JSON.stringify(nextMine));
    await window.storage.set('garden', JSON.stringify(nextGarden), true);
    setStatus('saved');
  };

  return (
    <div className="min-h-screen bg-emerald-50 p-4 flex justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Sprout className="w-6 h-6 text-emerald-600" /> Seed Swap</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input id="seed-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name a seed" />
            <Button id="plant" onClick={plant}><Plus className="w-4 h-4" /> Plant</Button>
          </div>
          <Tabs defaultValue="mine">
            <TabsList>
              <TabsTrigger value="mine">Mine</TabsTrigger>
              <TabsTrigger value="garden"><Users className="w-4 h-4 mr-1" /> Garden</TabsTrigger>
            </TabsList>
            <TabsContent value="mine">
              <ul id="mine">{mine.map((s) => <li key={s.at}>{s.name}</li>)}</ul>
            </TabsContent>
            <TabsContent value="garden">
              <ul id="garden">{garden.map((s) => <li key={s.at}>{s.name}</li>)}</ul>
            </TabsContent>
          </Tabs>
          <p id="status" className="text-xs text-gray-500">{status}</p>
        </CardContent>
      </Card>
    </div>
  );
}
