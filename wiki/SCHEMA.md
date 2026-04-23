# Wiki Schema

## Domain
Multidisciplinary research intelligence — AI/ML, computing, robotics, neuroscience, physics, biology, materials science, energy, cybersecurity. Sources come from daily matcha RSS/API pipeline (arXiv, Nature, Science, IEEE, PNAS, bioRxiv, etc.) plus conversational notes.

## Conventions
- File names: lowercase, hyphens, no spaces (e.g., `transformer-architecture.md`)
- Every wiki page starts with YAML frontmatter (see below)
- Use `[[wikilinks]]` to link between pages (minimum 2 outbound links per page)
- When updating a page, always bump the `updated` date
- Every new page must be added to `index.md` under the correct section
- Every action must be appended to `log.md`
- **Provenance markers:** On pages that synthesize 3+ sources, append `^[raw/articles/source-file.md]` at the end of paragraphs whose claims come from a specific source
- **Topic isolation:** Topics live in their sub-field directory (e.g., `topics/ai-ml/transformers.md`), but cross-field references are encouraged via wikilinks across directories
- **Auto-population:** Pages are NOT pre-created. They emerge from daily digests and conversations when entities/topics meet the page threshold
- **User & research awareness:** Digest agent checks `user/focuses/` and `research/*/STATUS.md` before curating — these signal what matters right now

## Frontmatter

### Wiki Pages (entities/, topics/, user/, research/)
```yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | topic | user | research | note
tags: [from taxonomy below]
sources: [raw/articles/source-name.md]
field: ai-ml | computing | robotics | neuroscience | physics | biology | materials | energy | cybersecurity | user | research
# Optional quality signals:
confidence: high | medium | low
contested: true
contradictions: [other-page-slug]
---
```

### Raw Sources (raw/articles/)
```yaml
---
ingested: YYYY-MM-DD
---
```

## Tag Taxonomy

### AI/ML (field: ai-ml)
- Models: model, architecture, benchmark, training, fine-tuning, inference, quantization
- Techniques: deep-learning, reinforcement-learning, alignment, reasoning, multimodal, agents
- Meta: open-source, proprietary, paper, announcement

### Computing (field: computing)
- Hardware: gpu, tpu, chip, semiconductor, accelerator
- Systems: parallel-computing, datacenter, cloud, distributed-systems, networking
- Emerging: quantum-computing, neuromorphic, photonic

### Robotics (field: robotics)
- Types: humanoid, drone, industrial, soft-robotics
- Techniques: control, perception, planning, manipulation, locomotion
- Meta: autonomous, simulation

### Neuroscience (field: neuroscience)
- Areas: brain-computer-interface, neural-coding, cognition, neuroplasticity
- Methods: imaging, stimulation, recording, modeling
- Meta: clinical, computational

### Physics (field: physics)
- Areas: particle-physics, cosmology, quantum-physics, condensed-matter, plasma
- Methods: simulation, experiment, observation
- Meta: theory, applied

### Biology (field: biology)
- Areas: genomics, proteomics, cell-biology, evolution, ecology
- Methods: sequencing, microscopy, modeling, crisper
- Meta: computational, wet-lab

### Materials Science (field: materials)
- Areas: nanomaterials, semiconductors, polymers, biomaterials, metamaterials
- Methods: synthesis, characterization, simulation
- Meta: computational, experimental

### Energy (field: energy)
- Areas: solar, nuclear, fusion, storage, grid, hydrogen
- Methods: modeling, experiment, deployment
- Meta: renewable, policy

### Cybersecurity (field: cybersecurity)
- Areas: cryptography, privacy, adversarial-ml, vulnerability, threat-intelligence
- Methods: analysis, defense, penetration-testing
- Meta: policy, compliance

### Cross-Field
- People: person, organization, company, lab, open-source-project
- Events: conference, workshop, grant, regulation
- Meta: timeline, comparison, controversy, prediction

**Rule:** Every tag on a page must appear in this taxonomy. If a new tag is needed, add it here first.

## Page Thresholds
- **Create a page** when an entity/topic appears in 2+ sources OR is central to one source
- **Add to existing page** when a source mentions something already covered
- **DON'T create a page** for passing mentions, minor details, or things outside the domain
- **Split a page** when it exceeds ~200 lines — break into sub-topics with cross-links
- **Archive a page** when its content is fully superseded — move to `_archive/`, remove from index

## Entity Pages
One page per notable entity. Include: overview, key facts, relationships to other entities ([[wikilinks]]), source references.

## Topic Pages
One page per concept or topic. Include: definition/explanation, current state of knowledge, open questions or debates, related topics ([[wikilinks]]).

## User Pages
Located in `user/`. Track user's profile, interests, and current focus areas.
- `user/profile.md` — bio, roles, background
- `user/interests.md` — broad interests, hobbies, preferences
- `user/focuses/*.md` — current focus areas; **flagged to digest agent as high-relevance signals**

## Research Pages
Located in `research/`, one sub-directory per active project.
- `research/<project>/STATUS.md` — current state, goals, last updated timestamp
- `research/<project>/notes.md` — working notes, findings
- Other project files as needed
- **Digest agent reads STATUS.md files** to surface articles relevant to active research

## Update Policy
When new information conflicts with existing content:
1. Check the dates — newer sources generally supersede older ones
2. If genuinely contradictory, note both positions with dates and sources
3. Mark the contradiction in frontmatter: `contradictions: [page-slug]`
4. Flag for user review in the lint report

## Directory Structure
```
wiki/
├── SCHEMA.md                 # This file — conventions, taxonomy, rules
├── TASTE.md                  # User taste preferences, meta-relevance pointers (manual)
├── index.md                  # Content catalog with one-line summaries
├── log.md                    # Chronological action log (append-only)
├── raw/
│   ├── articles/             # Daily intake: YYYY-MM-DD.md (accumulates all day)
│   └── assets/               # Images, diagrams from sources
├── entities/                 # People, orgs, products, models
├── topics/                   # Knowledge by sub-field
│   ├── ai-ml/
│   ├── computing/
│   ├── robotics/
│   ├── neuroscience/
│   ├── physics/
│   ├── biology/
│   ├── materials/
│   ├── energy/
│   └── cybersecurity/
├── user/                     # User profile, interests, current focuses
│   ├── profile.md
│   ├── interests.md
│   └── focuses/
├── research/                 # Active research projects
│   └── <project>/
│       ├── STATUS.md
│       └── notes.md
└── _archive/                 # Superseded pages
```
