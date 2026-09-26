import { normalizeText, slugify } from './util.js';

// Catálogo base de sectores. Sirve para: tipo Schema.org, etiquetas OSM (mapa de prospección),
// vocabulario del proveedor mock y consultas de búsqueda. Sectores no listados usan el perfil genérico.
export const SECTORS = [
  {
    id: 'restaurante', label: 'Restaurante', match: /restaur|tapas|gastro|comida|cocina|bar\b|cafeter|pizzer|asador|guachinche/,
    schema: 'Restaurant', osm: [['amenity', 'restaurant'], ['amenity', 'cafe'], ['amenity', 'bar'], ['amenity', 'fast_food']],
    cta: 'Reservar mesa', family: 'naranja', typography: 'serif',
    services: [
      ['Carta de temporada', 'Platos elaborados con producto local que cambian según el mercado.'],
      ['Menú del día', 'Una opción completa y equilibrada para comer bien entre semana.'],
      ['Eventos y grupos', 'Celebraciones, comidas de empresa y reservas para grupos.'],
      ['Comida para llevar', 'Tus platos favoritos listos para recoger.'],
    ],
  },
  {
    id: 'clinica-dental', label: 'Clínica dental', match: /dent|odont|ortodonc/,
    schema: 'Dentist', osm: [['amenity', 'dentist'], ['healthcare', 'dentist']],
    cta: 'Pedir cita', family: 'azul', typography: 'sans',
    services: [
      ['Odontología general', 'Revisiones, limpiezas y tratamientos para mantener tu boca sana.'],
      ['Ortodoncia', 'Brackets y alineadores transparentes para cada caso.'],
      ['Implantes dentales', 'Soluciones fijas para recuperar función y estética.'],
      ['Estética dental', 'Blanqueamiento y carillas con planificación previa.'],
      ['Odontopediatría', 'Atención adaptada a los más pequeños.'],
    ],
  },
  {
    id: 'peluqueria', label: 'Peluquería y estética', match: /pelu|barber|estetic|belleza|salon|uñas|manicur/,
    schema: 'HairSalon', osm: [['shop', 'hairdresser'], ['shop', 'beauty']],
    cta: 'Reservar cita', family: 'magenta', typography: 'display',
    services: [
      ['Corte y peinado', 'Cortes adaptados a tu estilo y a tu tipo de cabello.'],
      ['Color y mechas', 'Técnicas de coloración con productos de calidad profesional.'],
      ['Tratamientos capilares', 'Hidratación y reparación para un cabello más sano.'],
      ['Estética', 'Manicura, pedicura y cuidado facial.'],
    ],
  },
  {
    id: 'abogado', label: 'Despacho de abogados', match: /abogad|legal|jurid|despacho|asesor[ií]a|gestor/,
    schema: 'LegalService', osm: [['office', 'lawyer'], ['office', 'tax_advisor'], ['office', 'accountant']],
    cta: 'Solicitar consulta', family: 'azul', typography: 'serif',
    services: [
      ['Derecho civil', 'Contratos, herencias, reclamaciones y conflictos entre particulares.'],
      ['Derecho laboral', 'Despidos, reclamaciones salariales y asesoramiento a empresas.'],
      ['Derecho de familia', 'Divorcios, custodias y acuerdos con el máximo cuidado.'],
      ['Asesoría a empresas', 'Acompañamiento jurídico continuo para tu negocio.'],
    ],
  },
  {
    id: 'reformas', label: 'Reformas e instalaciones', match: /fontan|electric|reforma|instalac|climatiz|carpinter|pintor|construc/,
    schema: 'HomeAndConstructionBusiness', osm: [['craft', 'plumber'], ['craft', 'electrician'], ['craft', 'hvac'], ['craft', 'carpenter'], ['craft', 'painter']],
    cta: 'Pedir presupuesto', family: 'naranja', typography: 'sans',
    services: [
      ['Reformas integrales', 'Cocinas, baños y viviendas completas con un único interlocutor.'],
      ['Fontanería', 'Instalaciones, averías y sustitución de equipos.'],
      ['Electricidad', 'Instalaciones, boletines y mantenimiento.'],
      ['Urgencias', 'Atención rápida para averías que no pueden esperar.'],
    ],
  },
  {
    id: 'gimnasio', label: 'Gimnasio y fitness', match: /gimnas|fitness|crossfit|yoga|pilates|entrenad/,
    schema: 'ExerciseGym', osm: [['leisure', 'fitness_centre'], ['leisure', 'sports_centre']],
    cta: 'Prueba una clase', family: 'rojo', typography: 'display',
    services: [
      ['Sala de entrenamiento', 'Equipamiento completo para fuerza y cardio.'],
      ['Clases dirigidas', 'Sesiones en grupo para todos los niveles.'],
      ['Entrenamiento personal', 'Planes a medida con seguimiento.'],
      ['Nutrición', 'Pautas para acompañar tu entrenamiento.'],
    ],
  },
  {
    id: 'inmobiliaria', label: 'Inmobiliaria', match: /inmobil|pisos|vivienda|real estate/,
    schema: 'RealEstateAgent', osm: [['office', 'estate_agent']],
    cta: 'Valorar mi vivienda', family: 'verde', typography: 'sans',
    services: [
      ['Compra', 'Te ayudamos a encontrar la vivienda que buscas.'],
      ['Venta', 'Valoración, difusión y gestión hasta la firma.'],
      ['Alquiler', 'Gestión de alquileres para propietarios e inquilinos.'],
      ['Asesoramiento', 'Trámites, hipotecas y documentación.'],
    ],
  },
  {
    id: 'alojamiento', label: 'Alojamiento turístico', match: /hotel|apartament|alojamiento|hostal|casa rural|villa|bungalow/,
    schema: 'LodgingBusiness', osm: [['tourism', 'hotel'], ['tourism', 'apartment'], ['tourism', 'guest_house'], ['tourism', 'hostel']],
    cta: 'Consultar disponibilidad', family: 'turquesa', typography: 'serif',
    services: [
      ['Habitaciones', 'Espacios cómodos pensados para descansar.'],
      ['Desayuno', 'Empieza el día con productos de la zona.'],
      ['Experiencias', 'Recomendaciones y actividades en los alrededores.'],
      ['Reserva directa', 'Las mejores condiciones reservando con nosotros.'],
    ],
  },
  {
    id: 'taller', label: 'Taller mecánico', match: /taller|mecanic|coche|automo|neumatic/,
    schema: 'AutoRepair', osm: [['shop', 'car_repair'], ['shop', 'tyres']],
    cta: 'Pedir cita en el taller', family: 'rojo', typography: 'sans',
    services: [
      ['Mantenimiento', 'Revisiones, cambios de aceite y filtros.'],
      ['Diagnosis', 'Detección de averías con equipos actualizados.'],
      ['Neumáticos', 'Venta, montaje y alineado.'],
      ['Pre-ITV', 'Revisamos tu vehículo antes de la inspección.'],
    ],
  },
  {
    id: 'fisioterapia', label: 'Fisioterapia', match: /fisio|osteop|quiropr|rehabilit/,
    schema: 'MedicalBusiness', osm: [['healthcare', 'physiotherapist']],
    cta: 'Reservar sesión', family: 'verde', typography: 'sans',
    services: [
      ['Fisioterapia deportiva', 'Prevención y recuperación de lesiones.'],
      ['Terapia manual', 'Tratamiento de dolores musculares y articulares.'],
      ['Rehabilitación', 'Recuperación tras cirugías o lesiones.'],
      ['Suelo pélvico', 'Valoración y tratamiento especializado.'],
    ],
  },
  {
    id: 'veterinario', label: 'Clínica veterinaria', match: /veterin|mascota/,
    schema: 'VeterinaryCare', osm: [['amenity', 'veterinary']],
    cta: 'Pedir cita', family: 'verde', typography: 'sans',
    services: [
      ['Consulta general', 'Revisiones y vacunación para tu mascota.'],
      ['Cirugía', 'Intervenciones con seguimiento postoperatorio.'],
      ['Diagnóstico', 'Análisis y pruebas de imagen.'],
      ['Peluquería canina', 'Higiene y cuidado del pelo.'],
    ],
  },
  {
    id: 'tienda', label: 'Comercio local', match: /tienda|boutique|comercio|moda|regalo|floris|librer/,
    schema: 'Store', osm: [['shop', 'clothes'], ['shop', 'gift'], ['shop', 'florist'], ['shop', 'books'], ['shop', 'shoes']],
    cta: 'Visítanos', family: 'violeta', typography: 'display',
    services: [
      ['Selección de productos', 'Artículos elegidos con criterio y atención al detalle.'],
      ['Asesoramiento', 'Te ayudamos a encontrar lo que buscas.'],
      ['Encargos', 'Pedidos especiales y reservas.'],
      ['Tarjetas regalo', 'El regalo perfecto cuando no sabes qué elegir.'],
    ],
  },
];

export function resolveSector(input) {
  const text = normalizeText(input);
  const found = SECTORS.find((s) => s.match.test(text) || s.id === text);
  if (found) return found;
  const label = String(input || 'Negocio local').trim();
  return {
    id: slugify(label), label, match: null, schema: 'LocalBusiness', osm: [],
    cta: 'Contactar', family: 'azul', typography: 'sans',
    services: [
      [`Servicio principal de ${label.toLowerCase()}`, '[[PENDIENTE: describe tu servicio principal]]'],
      ['Atención personalizada', 'Escuchamos lo que necesitas y te proponemos la mejor solución.'],
      ['Presupuesto sin compromiso', 'Cuéntanos tu caso y te respondemos con una propuesta clara.'],
    ],
  };
}

// Mapea etiquetas OSM → sector del catálogo (para el mapa de prospección).
export function sectorFromOsmTags(tags = {}) {
  for (const s of SECTORS) if (s.osm.some(([k, v]) => tags[k] === v)) return s;
  return null;
}
