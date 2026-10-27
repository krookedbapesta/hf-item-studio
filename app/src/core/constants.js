// Values lifted from HFContentCreatorLib (ExporterConsts / ExporterLookups / ObjectValidator).

export const LIMITS = {
  maxVerticesTotalWarn: 65535,      // VERT_THRESHOLD (warning, summed over all meshes)
  maxMeshVertices: 64000,           // hard: MeshSerializer.ReadMesh throws above this
  maxMeshTriangles: 64000,          // hard
  triangleDensityWarn: 10000,       // TRIANGLE_DENSITY_THRESHOLD, triangles per m^3
  textureSizeWarn: 2048,            // TEXTURE_SIZE_THRESHOLD
  maxPackageBytes: 104857600,       // MAX_ITEM_FILE_SIZE_BYTES (100 MB)
  sizeWarn: 4,                      // SIZE_THRESHOLD metres on any axis
  maxPivotHeight: 2.9,              // MAX_HEIGHT
  maxNameLength: 128,
  maxLongText: 8000,
  thumbnailSize: 256,
  maxPreviewBytes: 1024 * 1024,     // Steam preview image limit
};

export const STEAM = {
  workshopAppId: 613100,            // House Flipper
  creatorAppId: 1471280,            // app id the Content Creator runs as
};

export const PLACEMENT = { Floor: 0, Ceiling: 1, Wall: 2 };
export const PLACEMENT_NAMES = ['Floor', 'Ceiling', 'Wall'];

export const VISIBILITY = [
  { id: 0, name: 'Public' },
  { id: 1, name: 'Friends only' },
  { id: 2, name: 'Private' },
  { id: 3, name: 'Unlisted' },
];

// Currency enum order and the kit's conversion rate to PLN (the unit stored in PriceInPLN).
export const CURRENCIES = [
  ['USD', 3.5651], ['AUD', 2.8309], ['GBP', 4.8369], ['CAD', 2.9007], ['EUR', 4.2746],
  ['JPY', 0.031818], ['NZD', 2.6065], ['NOK', 0.4332], ['PLN', 1], ['ZAR', 0.2535],
  ['SEK', 0.4484], ['CHF', 3.6807], ['CNY', 0.5523], ['RUB', 0.063], ['HUF', 0.0133],
  ['TRY', 1.22], ['KRW', 0.0033], ['CZK', 0.166], ['RON', 1.12], ['UAH', 0.1327],
  ['DKK', 0.5754], ['THB', 0.1268], ['SAR', 1.027], ['VND', 0.00017], ['BRL', 0.928],
].map(([code, rate], id) => ({ id, code, rate }));

export const toPLN = (price, currencyId) => price * (CURRENCIES[currencyId]?.rate ?? 1);
export const fromPLN = (pln, currencyId) => pln / (CURRENCIES[currencyId]?.rate ?? 1);

export const COMPONENT = { BoxCollider: 0, SphereCollider: 1, CapsuleCollider: 2, Mesh: 3 };

export const ALLOWED_SHADERS = ['Standard', 'Standard (Specular setup)'];

export const RENDER_QUEUE = { Opaque: 2000, Cutout: 2450, Transparent: 3000, Fade: 3000 };

// Blend mode (_Mode) values of Unity's Standard shader.
export const BLEND_MODE = { Opaque: 0, Cutout: 1, Fade: 2, Transparent: 3 };

// Default Standard shader float set, matching what the kit serializes.
export const STANDARD_FLOATS = {
  _Cutoff: 0.5,
  _Glossiness: 0.5,
  _GlossMapScale: 1.0,
  _SmoothnessTextureChannel: 0.0,
  _Metallic: 0.0,
  _SpecularHighlights: 1.0,
  _GlossyReflections: 1.0,
  _BumpScale: 1.0,
  _Parallax: 0.02,
  _OcclusionStrength: 1.0,
  _DetailNormalMapScale: 1.0,
  _UVSec: 0.0,
  _Mode: 0.0,
  _SrcBlend: 1.0,
  _DstBlend: 0.0,
  _ZWrite: 1.0,
};

export const SPECIAL_TAGS = {
  ceiling: 'Limits/Ceiling',
  hanging: 'Limits/Hanging',
  placeOn: 'Limits/Can Be Placed On',
};

// Wall items in the workshop sit with their back on the z = 0 plane and extend along +Z.
// A collider that touches the wall plane exactly makes the game report a collision, which
// is why creators nudge it out by hand; this is the default gap the wall fitter leaves.
export const WALL_COLLIDER_GAP = 0.005;
