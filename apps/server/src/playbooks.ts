/**
 * Place-specific narration playbooks.
 *
 * This is where most of the product value lives.
 *
 * A generic describer says "there is a large object ahead". A useful one says
 * "escalator ahead, going down, keep left" — but only if it already knows it
 * is in a shopping mall. The same grey rectangle is a kerb on a street, a step
 * in a house, and a platform edge at a station, and getting it wrong is the
 * difference between a helpful hint and a fall.
 *
 * So: classify the place first, then narrate with that place's vocabulary,
 * hazards and priorities.
 */

export const PLACE_CATEGORIES = [
  'home',
  'office',
  'mall',
  'shop',
  'restaurant',
  'hospital',
  'school',
  'station',
  'gym',
  'road',
  'park',
  'market',
  'parking',
  'sidewalk',
  'other',
] as const;

export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

export const ENVIRONMENTS = ['indoor', 'outdoor'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * What to name, what to watch for, and how to phrase it — per place.
 * Kept tight: every word here is added to a latency-sensitive prompt.
 */
export const PLAYBOOK: Record<PlaceCategory, string> = {
  home: `PLACE: a home.
Name rooms and furniture by what they are: doorway, worktop, dining table, sofa, bed, wardrobe, sink, cooker.
Call out reachable detail, because they are about to touch things: "the wardrobe handle is at your right hand", "the tap is just left of the sink", "the cooker knobs are at waist height in front of you".
Hazards that matter here: hot rings and ovens, kettles, sharp knives on worktops, open cupboard doors at head height, steps between rooms, stairs, trailing cables, water on the floor, a pet underfoot.
Give height as well as direction, since they are reaching, not walking: "at waist height", "just above your hand", "on the floor by your left foot".`,

  office: `PLACE: an office.
Name desks, chairs, partitions, meeting rooms, corridors, lifts, printers, the seating area, reception.
Hazards here: glass doors and glass partitions, chair legs and castors sticking into walkways, bags and cables on the floor, open drawers, automatic doors.
Help them navigate between zones: "the corridor continues ahead", "seating area on your right", "meeting room door on your left".
Read desk numbers, name plates and room signs when they are visible.`,

  mall: `PLACE: a shopping mall.
ALWAYS state the direction of stairs, escalators and travelators — "escalator ahead going up", "stairs ahead going down". Never say just "stairs".
If they are already standing on a moving escalator or travelator, say so plainly and tell them to hold the rail and stay still.
Name shop fronts, entrances, the atrium, handrails, lifts, floor level, toilets, exits, food court.
Hazards here: the top and bottom of escalators, atrium railings and open drops, wet floor signs, planters and bins in the walkway, glass shopfronts, children running.
Warn before the end of an escalator so they can prepare to step off.`,

  shop: `PLACE: a shop.
Name aisles, shelves, the checkout, baskets and trolleys, the entrance and exit, refrigerated cabinets.
Say which way the aisle runs and how wide the gap is.
Read shelf labels, aisle signs and prices when they are legible.
Hazards here: trolleys and baskets left in the aisle, stacked boxes, stepladders, wet floors, low shelf corners.`,

  restaurant: `PLACE: a café or restaurant.
Name tables, chairs, the counter, the queue, menu boards, the till, the way to the toilets.
Say whether a table is free and where its chair is: "empty table on your right, chair pulled out".
Hazards here: chair legs in the walkway, tables at hip height, hot drinks and plates, steps between levels, staff carrying trays.`,

  hospital: `PLACE: a hospital or clinic.
Name reception, the waiting area, seating, the queue, corridors, lifts, wards, ticket and token machines.
Read department names, room numbers, direction signs and any called number displays — these are how they find where to go.
Hazards here: trolleys and beds being moved, wheelchairs, IV stands, cleaning equipment, wet floors, doors that swing.
Be calm and factual. People here are often already stressed.`,

  school: `PLACE: a school or college.
Name corridors, classrooms, stairs and their direction, lockers, noticeboards, the hall, the office.
Read room numbers and door signs.
Hazards here: crowds between lessons, bags on the floor, doors opening outward, stairs.`,

  station: `PLACE: a station or transport hub.
THE PLATFORM EDGE IS THE FIRST PRIORITY. If a platform edge or tactile warning strip is visible, say so immediately and which side it is on, before anything else.
Name platforms, tactile paving, ticket gates, ticket machines, the ticket office, stairs and their direction, lifts, seating, the train or bus itself.
Read platform numbers, destinations and departure boards.
Hazards here: the platform edge, the gap at the train door, ticket gates closing, luggage and trolleys, crowds, stairs.`,

  gym: `PLACE: a gym.
Name machines, benches, free weights, mats, the walkway between equipment.
Hazards here: weights and dumbbells left on the floor, moving machine parts, benches at shin height, people mid-exercise.`,

  road: `PLACE: a road or traffic environment. TREAT THIS AS THE HIGHEST-RISK SETTING.
State which part of the road they are on: pavement, kerb, road edge, crossing, central island, roundabout.
Say clearly when they reach a kerb and whether it steps up or down.
At a crossing: name the type — zebra, signalled, or unmarked — and whether you can see a signal or a push button, and which side the button is on.
If you cannot tell whether it is safe to cross, say exactly that. NEVER tell them it is safe to cross. Never say "go" or "cross now".
Say which direction traffic is coming from and whether it is moving fast or queued.
Hazards here: kerbs, moving and turning vehicles, cycle lanes, driveways, parked cars blocking the pavement, road works, drain covers.`,

  park: `PLACE: a park or green space.
Name the path or trail and its surface — paved, gravel, dirt, grass — and where it goes: straight, curving left, forking, opening out.
Say what borders the path on each side: grass, hedge, water, railing, drop.
Name benches, bins, lamp posts, play areas, ponds, bridges, gates.
Hazards here: cyclists and runners from behind, loose dogs, tree roots and uneven ground, low branches, mud and puddles, the water's edge.
Keep them oriented to the path: "the trail curves gently left", "keep slightly right to stay on the path".`,

  market: `PLACE: a market or bazaar.
Name stalls and what they sell, the lane between stalls and how wide it is, where the lane opens out.
Hazards here: crowds and people stopping suddenly, stall awnings and poles at head height, goods stacked into the walkway, uneven ground and cables, carts and bikes pushing through, steps.
Say where the clear line through the crowd is.`,

  parking: `PLACE: a car park.
Vehicles here move slowly but unpredictably and drivers often cannot see a pedestrian. Prioritise anything with lights on or reversing.
Name parking bays, marked walkways, ramps and their direction, pillars, barriers, pay machines, the exit on foot.
Hazards here: reversing cars, cars moving between bays, ramps, low barriers and chains, pillars, oil and puddles.`,

  sidewalk: `PLACE: a pavement or footpath beside a road.
Say which side the road is on and how far away it is.
Name the kerb, crossings, driveways, bus stops, street furniture.
Hazards here: the kerb edge, lamp posts, sign poles, bins, bollards, A-boards, scaffolding, parked cars and bikes across the path, driveways where vehicles cross the pavement, overhanging branches.
Tell them where the clear width of the path is.`,

  other: `PLACE: not clearly identified.
Describe the ground surface and where the walkable route goes.
Name the largest fixed features and any doorway, stairs, or opening.
Do not guess at the type of place. Describe only what is actually visible.`,
};

/** A compact hint list used by the classifier prompt. */
export const CATEGORY_HINT = PLACE_CATEGORIES.join(', ');
