import { describe, expect, it } from 'vitest';
import { PAIN_RESPONSE_PATTERNS, painRecoilScale, painResponseAt, painResponsePattern } from '../services/painResponse';
const input = {intensity:5,expression:0.65,onsetMs:600,releaseMs:3000,timeMs:1600};
describe('movement-evoked pain expression',()=>{
  it('is quiet before provocation, at zero intensity/expression and after recovery',()=>{
    for (const change of [{timeMs:500},{timeMs:4000},{intensity:0},{expression:0},{intensity:NaN},{timeMs:NaN},{releaseMs:600}]) {
      const response=painResponseAt({...input,...change});
      for(const [key,value] of Object.entries(response)) if(key!=='activation') expect(value,key).toBe(0);
    }
  });
  it('scales channels continuously without assigning a clinical score from appearance',()=>{
    const responses=[0,2,5,8,10].map(intensity=>painResponseAt({...input,intensity,timeMs:900}));
    for(const key of ['brow','squint','eyeClosure','mouth','handClench','flinch','guarding'] as const) for(let i=1;i<responses.length;i++) expect(responses[i][key]).toBeGreaterThanOrEqual(responses[i-1][key]);
    expect(painResponseAt({...input,intensity:10,expression:0}).brow).toBe(0);
  });
  it('has one onset flinch and seeks reproducibly, with bounded weights and smooth release',()=>{
    expect(painResponseAt({...input,timeMs:900}).flinch).toBeGreaterThan(0);
    expect(painResponseAt(input).flinch).toBe(0);
    expect(painResponseAt(input)).toEqual(painResponseAt(input));
    let previous=painResponseAt({...input,timeMs:3000}).brow;
    for(let timeMs=3010;timeMs<=3700;timeMs+=10) {const current=painResponseAt({...input,timeMs}).brow;expect(current).toBeLessThanOrEqual(previous);previous=current;}
    for(let timeMs=0;timeMs<4300;timeMs+=10) for(const value of Object.values(painResponseAt({...input,intensity:99,expression:99,timeMs}))) {expect(value).toBeGreaterThanOrEqual(0);expect(value).toBeLessThanOrEqual(1);}
  });
  it('provides distinct patterns, with a brief onset response and genuinely quiet facial activity',()=>{
    const sample={...input,intensity:8,expression:1};
    const held=PAIN_RESPONSE_PATTERNS.map(pattern=>painResponseAt({...sample,pattern:pattern.id}));
    expect(new Set(held.map(response=>JSON.stringify(response))).size).toBe(PAIN_RESPONSE_PATTERNS.length);
    const wince= painResponseAt({...sample,pattern:'wince',timeMs:900});
    const later= painResponseAt({...sample,pattern:'wince'});
    expect(wince.eyeClosure).toBeGreaterThan(later.eyeClosure*3);
    expect(wince.handClench).toBeGreaterThan(later.handClench*3);
    expect(painResponseAt({...sample,pattern:'open-mouth'}).jawOpen).toBeGreaterThan(0.2);
    expect(painResponseAt({...sample,pattern:'open-mouth'}).mouth).toBe(0);
    expect(painResponseAt({...sample,pattern:'raised-brow'}).brow).toBe(0);
    expect(painResponseAt({...sample,pattern:'raised-brow'}).browRaise).toBeGreaterThan(0);
    const quiet=painResponseAt({...sample,pattern:'quiet'});
    for(const key of ['brow','browRaise','squint','eyeClosure','mouth','nose','jawOpen','flinch'] as const) expect(quiet[key]).toBe(0);
    expect(quiet.handClench).toBeGreaterThan(0);
    expect(painRecoilScale({...sample,pattern:'quiet'})).toBe(0);
    expect(painResponsePattern('unknown').id).toBe('grimace');
  });
  it.each(PAIN_RESPONSE_PATTERNS)('$id is bounded, reproducible and fully releases on its playback clock',pattern=>{
    for(let timeMs=0;timeMs<=4300;timeMs+=20) {
      const state={...input,pattern:pattern.id,timeMs,intensity:99,expression:99};
      const response=painResponseAt(state);
      expect(response).toEqual(painResponseAt(state));
      for(const value of Object.values(response)) {expect(value).toBeGreaterThanOrEqual(0);expect(value).toBeLessThanOrEqual(1);}
      for(const change of [{expression:0},{intensity:0}]) for(const [key,value] of Object.entries(painResponseAt({...state,...change}))) if(key!=='activation') expect(value,key).toBe(0);
    }
    for(const [key,value] of Object.entries(painResponseAt({...input,pattern:pattern.id,timeMs:4200}))) expect(value,key).toBe(0);
  });
});
