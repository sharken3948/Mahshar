'use client'

import type { DeclaredParameter } from '@/lib/marketplace/proxy-target'

const inputClass = 'w-full rounded-lg border border-[#B7CAE3] bg-white px-3 py-2 text-sm text-[#172033] outline-none focus:border-[#2775CA]'

export function RequestParameterEditor({ location, value, onChange }: {
  location: 'path' | 'query'
  value: DeclaredParameter[]
  onChange: (value: DeclaredParameter[]) => void
}) {
  const label = location === 'path' ? 'Path parameters' : 'Query parameters'
  const add = () => onChange([...value, { name: '', type: 'string', required: location === 'path', description: '', example: '' }])
  const update = (index: number, patch: Partial<DeclaredParameter>) => onChange(value.map((parameter, itemIndex) =>
    itemIndex === index ? { ...parameter, ...patch } : parameter))
  const remove = (index: number) => onChange(value.filter((_, itemIndex) => itemIndex !== index))

  return <section className="rounded-xl border border-[#D8E3F2] bg-[#F8FBFF] p-4 space-y-3">
    <div className="flex items-start justify-between gap-3">
      <div><h3 className="text-sm font-semibold text-[#172033]">{label}</h3><p className="text-xs text-[#5B6B82]">{location === 'path'
        ? 'Values are appended to the endpoint in this order.'
        : 'Only these buyer inputs are allowed. Authentication query values stay private.'}</p></div>
      <button type="button" onClick={add} className="shrink-0 rounded-lg border border-[#2775CA] px-3 py-1.5 text-xs font-semibold text-[#2775CA]">Add parameter</button>
    </div>
    {value.length === 0 && <p className="rounded-lg border border-dashed border-[#B7CAE3] px-3 py-3 text-xs text-[#6B7280]">No {location} inputs declared.</p>}
    {value.map((parameter, index) => <div key={`${location}-${index}`} className="rounded-lg border border-[#C8D8EC] bg-white p-3 space-y-3">
      <div className="grid gap-3 md:grid-cols-[1.2fr_.8fr_auto_auto]">
        <label className="text-xs font-medium text-[#40516A]">Name<input aria-label={`${label} name ${index + 1}`} value={parameter.name} onChange={event => update(index, { name: event.target.value })} placeholder={location === 'path' ? 'address' : 'limit'} className={inputClass} /></label>
        <label className="text-xs font-medium text-[#40516A]">Type<select value={parameter.type ?? 'string'} onChange={event => update(index, { type: event.target.value as DeclaredParameter['type'] })} className={inputClass}><option value="string">Text</option><option value="integer">Integer</option><option value="number">Number</option><option value="boolean">True / false</option></select></label>
        <label className="flex items-end gap-2 pb-2 text-xs font-medium text-[#40516A]"><input type="checkbox" checked={parameter.required === true} onChange={event => update(index, { required: event.target.checked })} />Required</label>
        <button type="button" onClick={() => remove(index)} className="self-end pb-2 text-xs font-semibold text-[#B42318]">Remove</button>
      </div>
      <label className="block text-xs font-medium text-[#40516A]">Description<input value={parameter.description ?? ''} onChange={event => update(index, { description: event.target.value })} placeholder="What should the buyer provide?" className={inputClass} /></label>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs font-medium text-[#40516A]">Example<input value={parameter.example === undefined ? '' : String(parameter.example)} onChange={event => update(index, { example: event.target.value === '' ? undefined : event.target.value })} placeholder={location === 'path' ? '0x1234…' : '10'} className={inputClass} /></label>
        <label className="text-xs font-medium text-[#40516A]">Allowed values (optional)<input value={parameter.enum?.join(', ') ?? ''} onChange={event => update(index, { enum: event.target.value.trim() ? event.target.value.split(',').map(item => item.trim()).filter(Boolean) : undefined })} placeholder="volume24h, marketCap" className={inputClass} /></label>
      </div>
      {(parameter.type === 'integer' || parameter.type === 'number') && <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs font-medium text-[#40516A]">Minimum<input type="number" value={parameter.minimum ?? ''} onChange={event => update(index, { minimum: event.target.value === '' ? undefined : Number(event.target.value) })} className={inputClass} /></label>
        <label className="text-xs font-medium text-[#40516A]">Maximum<input type="number" value={parameter.maximum ?? ''} onChange={event => update(index, { maximum: event.target.value === '' ? undefined : Number(event.target.value) })} className={inputClass} /></label>
      </div>}
      {parameter.pattern && <p className="text-xs text-[#6B7280]">This parameter keeps its existing safe format constraint. Saving does not convert it into executable code.</p>}
    </div>)}
  </section>
}
