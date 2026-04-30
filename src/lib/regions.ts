// Region groupings for Sydney suburbs. Used by the location filter to let users
// select e.g. "Eastern Suburbs" instead of picking individual suburbs.
//
// One suburb can appear in multiple regions if useful. New suburbs added via
// admin won't auto-appear here — add them by hand below.

export interface Region {
  slug: string;
  name: string;
  suburbs: string[];
}

export const REGIONS: Region[] = [
  {
    slug: 'cbd',
    name: 'Sydney CBD',
    suburbs: [
      'cbd', 'haymarket', 'chinatown', 'the-rocks', 'dawes-point', 'walsh-bay',
      'millers-point', 'barangaroo', 'darling-harbour', 'darling-square',
      'circular-quay', 'ultimo', 'pyrmont',
    ],
  },
  {
    slug: 'eastern-suburbs',
    name: 'Eastern Suburbs',
    suburbs: [
      'bondi', 'bondi-beach', 'bondi-junction', 'north-bondi', 'bronte',
      'tamarama', 'clovelly', 'coogee', 'randwick', 'kensington', 'kingsford',
      'maroubra', 'malabar', 'little-bay', 'chifley', 'eastgardens',
      'hillsdale', 'daceyville', 'eastlakes', 'pagewood', 'matraville',
      'queens-park', 'centennial-park', 'moore-park', 'waverley',
      'paddington', 'woollahra', 'double-bay', 'bellevue-hill', 'vaucluse',
      'rose-bay', 'dover-heights', 'watsons-bay', 'point-piper', 'edgecliff',
      'darling-point', 'darlinghurst', 'elizabeth-bay', 'potts-point',
      'kings-cross', 'rushcutters-bay', 'woolloomooloo', 'surry-hills',
    ],
  },
  {
    slug: 'inner-south',
    name: 'Inner South',
    suburbs: [
      'redfern', 'chippendale', 'darlington', 'alexandria', 'beaconsfield',
      'waterloo', 'zetland', 'rosebery', 'mascot', 'botany', 'banksmeadow',
    ],
  },
  {
    slug: 'inner-west',
    name: 'Inner West',
    suburbs: [
      'newtown', 'enmore', 'erskineville', 'st-peters', 'sydenham', 'tempe',
      'marrickville', 'dulwich-hill', 'lewisham', 'summer-hill', 'petersham',
      'stanmore', 'leichhardt', 'balmain', 'balmain-east', 'birchgrove',
      'rozelle', 'lilyfield', 'annandale', 'camperdown', 'ashfield',
      'haberfield', 'croydon', 'burwood', 'drummoyne', 'five-dock',
      'abbotsford', 'russell-lea', 'wareemba', 'concord', 'concord-west',
      'north-strathfield', 'strathfield', 'homebush', 'homebush-west',
      'rhodes', 'flemington', 'olympic-park', 'glebe', 'forest-lodge',
      'hurlstone-park', 'earlwood', 'canterbury', 'canada-bay',
    ],
  },
  {
    slug: 'lower-north-shore',
    name: 'Lower North Shore',
    suburbs: [
      'north-sydney', 'mcmahons-point', 'milsons-point', 'kirribilli',
      'lavender-bay', 'lavendar-bay', 'neutral-bay', 'cremorne',
      'cremorne-point', 'mosman', 'balmoral', 'beauty-point',
      'clifton-gardens', 'cammeray', 'waverton', 'wollstonecraft',
      'st-leonards', 'crows-nest', 'willoughby', 'artarmon', 'chatswood',
      'lane-cove', 'greenwich', 'northbridge', 'middle-cove', 'castlecrag',
      'woolwich',
    ],
  },
  {
    slug: 'upper-north-shore',
    name: 'Upper North Shore',
    suburbs: [
      'gordon', 'killara', 'lindfield', 'roseville', 'pymble', 'st-ives',
      'turramurra', 'wahroonga', 'warrawee', 'hornsby', 'waitara',
      'normanhurst', 'thornleigh', 'pennant-hills', 'west-pennant-hills',
      'epping', 'eastwood', 'west-ryde', 'north-ryde', 'ryde', 'meadowbank',
      'macquarie-park', 'carlingford',
    ],
  },
  {
    slug: 'northern-beaches',
    name: 'Northern Beaches',
    suburbs: [
      'manly', 'fairlight', 'freshwater', 'balgowlah', 'seaforth', 'clontarf',
      'brookvale', 'dee-why', 'narrabeen', 'mona-vale', 'avalon', 'palm-beach',
      'collaroy', 'curl-curl', 'warriewood', 'newport', 'whale-beach',
    ],
  },
  {
    slug: 'south',
    name: 'South & St George',
    suburbs: [
      'rockdale', 'kogarah', 'hurstville', 'brighton-le-sands', 'monterey',
      'kyeemagh', 'sans-souci', 'ramsgate', 'blakehurst', 'allawah',
      'mortdale', 'oatley', 'penshurst', 'padstow', 'panania', 'revesby',
      'arncliffe', 'wolli-creek', 'bexley', 'bexley-north', 'carlton',
      'st-george',
    ],
  },
  {
    slug: 'sutherland-shire',
    name: 'Sutherland Shire',
    suburbs: [
      'cronulla', 'miranda', 'sutherland', 'gymea', 'caringbah', 'sylvania',
    ],
  },
  {
    slug: 'south-west',
    name: 'South West',
    suburbs: [
      'bankstown', 'lakemba', 'punchbowl', 'wiley-park', 'belmore', 'campsie',
      'greenacre',
    ],
  },
  {
    slug: 'west',
    name: 'Greater West',
    suburbs: [
      'parramatta', 'north-parramatta', 'harris-park', 'granville', 'rosehill',
      'auburn', 'lidcombe', 'blacktown', 'fairfield', 'cabramatta',
      'canley-heights', 'canley-vale', 'liverpool', 'wentworthville',
      'westmead',
    ],
  },
];

export function getRegion(slug: string): Region | undefined {
  return REGIONS.find((r) => r.slug === slug);
}
