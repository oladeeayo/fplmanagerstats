// 2025/26 PL squads — positions mapped by web_name (FPL's display name)
const DETAILED_POSITIONS = {
  // Arsenal
  "Raya": "GK", "Arrizabalaga": "GK", "Meslier": "GK",
  "Gabriel": "LCB", "J.Timber": "RB", "Saliba": "RCB",
  "Calafiori": "LB", "Hincapie": "LCB", "White": "RB", "Mosquera": "RCB",
  "Saka": "RW", "Rice": "CDM", "Eze": "CAM", "Ødegaard": "CAM",
  "Madueke": "RW", "Merino": "CM", "Martinelli": "LW", "Zubimendi": "CDM",
  "Dowman": "CM", "Nørgaard": "CDM", "Nwaneri": "RW", "Fábio Vieira": "CAM",
  "Nelson": "LW", "Lewis-Skelly": "LB",
  "Gyökeres": "ST", "Havertz": "ST", "G.Jesus": "ST", "Tzolis": "LW",

  // Aston Villa
  "Martinez": "GK", "M.Bizot": "GK",
  "Digne": "LB", "Konsa": "RCB", "Cash": "RB", "Mings": "LCB", "Pau": "LCB",
  "Maatsen": "LB", "Lindelöf": "RCB", "A.García": "RB", "Nedeljkovic": "RB",
  "Buendía": "CAM", "Bailey": "RW", "McGinn": "CM", "Barkley": "CM",
  "Kamara": "CDM", "Onana": "CDM", "Iling Jr": "LW", "Garnacho": "LW",
  "Guessand": "CM", "Gomes": "CM",
  "Watkins": "ST", "Abraham": "ST",

  // Bournemouth
  "Petrović": "GK", "Forster": "GK", "Dennis": "GK",
  "Hill": "CB", "Truffert": "LB", "Diakité": "RCB", "Smith": "RB",
  "J.Araujo": "RB", "Soler": "LB", "Milosavljević": "CB",
  "Tavernier": "LW", "Scott": "CM", "Kluivert": "RW", "Cook": "CM",
  "Gannon-Doak": "RW", "Adams": "CDM", "Brooks": "RW", "Christie": "CM",
  "Rayan": "CM", "Adli": "LW", "Kroupi.Jr": "ST",
  "Evanilson": "ST", "Enes Ünal": "ST", "Rodríguez": "ST",

  // Brentford
  "Kelleher": "GK", "Valdimarsson": "GK",
  "Collins": "RCB", "Van den Berg": "LCB", "Ajer": "CB",
  "Kayode": "RB", "Henry": "LB", "Hickey": "RB", "Pinnock": "LCB",
  "Ji-soo": "CB", "Schuster": "CB",
  "Schade": "RW", "O.Dango": "RW", "Damsgaard": "CAM",
  "Jensen": "CM", "Janelt": "CDM", "Dasilva": "CM", "Henderson": "CM",
  "Lewis-Potter": "LW", "Milambo": "CM", "Carvalho": "CAM",
  "Yarmoliuk": "CM", "Anthony": "LW",
  "Thiago": "ST", "Furo": "ST", "Wilson": "ST",

  // Brighton
  "Verbruggen": "GK", "Rushworth": "GK", "Steele": "GK",
  "F.Kadıoğlu": "RB", "Boscagli": "LCB", "De Cuyper": "LB",
  "Dunk": "RCB", "Igor": "CB", "Costinha": "CB", "Svoboda": "CB",
  "Coppola": "CB", "Struijk": "LCB", "Vuskovic": "RCB",
  "Mitoma": "LW", "Minteh": "RW", "Hinshelwood": "CM",
  "Groß": "CM", "Georginio": "ST", "O'Riley": "CM",
  "Gomez": "CM", "Buonanotte": "CAM", "Ayari": "CM",
  "Wieffer": "CDM", "Baleba": "CDM",
  "Welbeck": "ST", "Tzimas": "ST", "Ferguson": "ST", "Kostoulas": "ST",

  // Chelsea
  "Sánchez": "GK", "Jörgensen": "GK",
  "James": "RB", "Chalobah": "CB", "Gusto": "RB", "Fofana": "RCB",
  "B.Badiashile": "LCB", "Tosin": "RCB", "Hato": "LB",
  "Colwill": "LCB", "M.Sarr": "CB", "Acheampong": "CB", "Disasi": "CB",
  "Palmer": "CAM", "Enzo": "CM", "Neto": "LW",
  "Estêvão": "RW", "Gittens": "LW", "Caicedo": "CDM", "Lavia": "CDM",
  "D.Essugo": "CDM", "Quenda": "RW",
  "João Pedro": "ST", "N.Jackson": "ST", "Delap": "ST",
  "Marc Guiu": "ST", "Mheuka": "ST", "Emegha": "ST",
  "Rogers": "CAM",

  // Coventry
  "Dovin": "GK", "Wilson": "GK",
  "Thomas": "CB", "Kitching": "LCB", "van Ewijk": "RB",
  "Dasilva": "LB", "Kesler-Hayden": "LB", "Bidwell": "LB",
  "Latibeaudiere": "CB", "Woolfenden": "RCB", "Brau": "LB", "Amenda": "CB",
  "Rudoni": "CM", "Grimes": "CM", "Sakamoto": "RW",
  "Mason-Clark": "LW", "Eccles": "CM", "Torp": "CM",
  "Shepherd": "CM", "Tchaouna": "RW", "Borges Rodrigues": "CM", "Andrews": "CM",
  "Wright": "ST", "Thomas-Asante": "ST", "Simms": "ST",
  "Markelo": "ST", "Bassette": "ST",
  "Onyeka": "CDM",

  // Crystal Palace
  "Henderson": "GK", "Benitez": "GK", "Matthews": "GK",
  "Lacroix": "RCB", "Muñoz": "RB", "Richards": "CB",
  "Mitchell": "LB", "Sosa": "LB", "Chadi Riad": "CB",
  "Mingueza": "RB", "Cardines": "LB", "Canvot": "CB",
  "Sarr": "RW", "Johnson": "LW", "Wharton": "CM",
  "Yeremy": "LW", "Hughes": "CM", "Lerma": "CDM",
  "Kamada": "CAM", "Doucouré": "CDM", "Esse": "CM",
  "M.França": "RW", "J.Rak-Sakyi": "RW", "Drakes-Thomas": "CM",
  "Strand Larsen": "ST", "Mateta": "ST", "Nketiah": "ST", "Uche": "ST",

  // Everton
  "Pickford": "GK", "Travers": "GK", "King": "GK",
  "Tarkowski": "RCB", "Branthwaite": "LCB", "Keane": "CB",
  "O'Brien": "CB", "Mykolenko": "LB", "Patterson": "RB", "Aznou": "LB",
  "Dewsbury-Hall": "CM", "Ndiaye": "LW", "Garner": "CM",
  "Iroegbunam": "CM", "McNeil": "LW", "George": "RW",
  "Alcaraz": "CAM", "Armstrong": "CM", "Dibling": "RW",
  "Röhl": "CM", "Hackney": "CM",
  "Beto": "ST", "Barry": "ST",

  // Fulham
  "Leno": "GK", "Lecomte": "GK", "McNally": "GK",
  "Andersen": "RCB", "Robinson": "LB", "J.Cuenca": "LCB",
  "Tete": "RB", "Bassey": "LCB", "Castagne": "RB", "Sessegnon": "LB",
  "Iwobi": "LW", "Smith Rowe": "CAM", "Kevin": "CM",
  "Bobb": "CAM", "Berge": "CDM", "Cairney": "CM",
  "Lukić": "CM", "King": "CM", "Reed": "CM",
  "Muniz": "ST", "Kusi-Asare": "ST",

  // Hull City
  "Phillips": "GK", "Butland": "GK", "Cartwright": "GK", "Lo-Tutala": "GK",
  "Egan": "RCB", "Hughes": "LCB", "Ajayi": "CB",
  "Coyle": "RB", "Drameh": "RB", "Giles": "LB",
  "Jacob": "CB", "McCarthy": "CB", "McNair": "CB", "Targett": "LB",
  "Belloumi": "RW", "Millar": "LW", "Dowell": "CM",
  "Crooks": "CM", "Slater": "CM", "Matazo": "CDM",
  "Ömür": "CAM", "Kamara": "LW", "Zambrano": "CM",
  "Akintola": "LW", "Gyabi": "CM",
  "McBurnie": "ST", "Destan": "ST", "Burstow": "ST",

  // Ipswich Town
  "Walton": "GK", "Palmer": "GK", "Button": "GK", "Van Oevelen": "GK",
  "Diop": "RCB", "Kipré": "CB", "O'Shea": "LCB",
  "Davis": "LB", "Greaves": "LCB", "Johnson": "RB", "Furlong": "RB",
  "Núñez": "CM", "Matusiwa": "CDM", "Burns": "RW",
  "Taylor": "CM", "Clarke": "LW", "Ogbene": "RW",
  "Fatawu": "RW", "Szmodics": "CAM", "Philogene": "LW",
  "McAteer": "RW", "Mehmeti": "LW",
  "Emersonn": "ST", "Hirst": "ST", "Akpom": "ST",
  "Al-Hamadi": "ST", "Walle Egeli": "ST",

  // Leeds United
  "Perri": "GK",
  "Bijol": "RCB", "Rodon": "LCB", "Bogle": "RB",
  "Gudmundsson": "LB", "Justin": "RB", "Bornauw": "CB",
  "Muharemović": "CB",
  "Wilson": "RW", "Stach": "CM", "Okafor": "LW",
  "Aaronson": "CAM", "Ampadu": "CDM", "Longstaff": "CM",
  "Gelhardt": "ST", "Gnonto": "LW", "Harrison": "RW",
  "James": "RW", "Gruev": "CM", "Tanaka": "CM",
  "Calvert-Lewin": "ST", "Nmecha": "ST", "Piroe": "ST",
  "Mateo Joseph": "ST",

  // Liverpool
  "A.Becker": "GK", "Mamardashvili": "GK", "Woodman": "GK",
  "Pecsi": "GK", "Jaros": "GK", "Davies": "GK",
  "Virgil": "LCB", "Frimpong": "RB", "Kerkez": "LB",
  "Gomez": "CB", "Bradley": "RB", "Lucky": "CB",
  "Jacquet": "CB", "Leoni": "LB", "Tsimikas": "LB", "Ramsay": "RB",
  "Wirtz": "CAM", "Gakpo": "LW", "Szoboszlai": "CAM",
  "Chiesa": "RW", "Gravenberch": "CDM", "Mac Allister": "CM",
  "C.Jones": "CM", "Endo": "CDM", "Nyoni": "CM",
  "Bajcetic": "CDM", "Munoz": "CM", "McConnell": "CM",
  "Elliott": "CAM", "Koumas": "LW",
  "Isak": "ST", "Ekitiké": "ST", "Danns": "ST",

  // Man City
  "Donnarumma": "GK", "Trafford": "GK", "Bettinelli": "GK",
  "O'Reilly": "CB", "Guéhi": "RCB", "Rúben": "LCB",
  "Gvardiol": "LB", "Aït-Nouri": "LB", "Khusanov": "RCB",
  "Alleyne": "CB", "Lewis": "RB", "Vitor Reis": "CB",
  "Matheus N.": "CB",
  "Grealish": "LW", "Foden": "CAM", "Cherki": "CAM",
  "Doku": "RW", "Savinho": "RW", "Semenyo": "LW",
  "Rodrigo": "CDM", "Reijnders": "CM", "N.Gonzalez": "CM",
  "Kovačić": "CDM", "Echeverri": "CAM", "Phillips": "CDM",
  "Anderson": "CM", "Mukasa": "CM", "Monga": "CM",
  "Marmoush": "ST", "Haaland": "ST",

  // Man United
  "Darlow": "GK", "Lammens": "GK", "Bayindir": "GK", "Heaton": "GK",
  "De Ligt": "RCB", "Dalot": "RB", "Maguire": "CB",
  "Martinez": "LCB", "Yoro": "RCB", "Heaven": "CB",
  "Mazraoui": "RB", "Shaw": "LB", "Amass": "LB", "Fredricson": "CB",
  "B.Fernandes": "CAM", "Mbeumo": "RW", "Cunha": "ST",
  "Rashford": "LW", "Mount": "CAM", "Amad": "RW",
  "Mainoo": "CM", "Ugarte": "CDM", "Dorgu": "LW",
  "Tielemans": "CM", "Andrey Santos": "CM",
  "J.Fletcher": "CM", "Lacey": "CM", "Collyer": "CDM",
  "Bendito Mantato": "LW", "Fletcher": "CM",
  "Šeško": "ST", "Zirkzee": "ST", "Obi": "ST",

  // Newcastle
  "Pope": "GK", "Gillespie": "GK", "Jaouen": "GK",
  "Thiaw": "RCB", "Schär": "LCB", "Botman": "LCB",
  "Burn": "CB", "Hall": "LB", "Livramento": "RB", "A.Murphy": "LB",
  "Bruno G.": "CM", "Barnes": "LW", "Elanga": "RW",
  "J.Ramsey": "CM", "J.Murphy": "RW", "Joelinton": "CDM",
  "L.Miley": "CM", "Willock": "CM", "Touré": "LW", "Steur": "CM",
  "Woltemade": "ST", "Wissa": "ST", "Osula": "ST", "Neave": "ST",

  // Nottm Forest
  "Sels": "GK", "John": "GK",
  "N.Williams": "RB", "Morato": "CB", "Milenković": "RCB",
  "Murillo": "LCB", "Aina": "LB", "Jair Cunha": "CB",
  "Savona": "CB", "O.Richards": "LB", "Abbott": "CB",
  "Netz": "LB", "Bindon": "CB",
  "Gibbs-White": "CAM", "Hudson-Odoi": "LW", "Ndoye": "RW",
  "Hutchinson": "RW", "Bakwa": "LW", "McAtee": "CAM",
  "Dominguez": "CM", "Sangaré": "CDM", "Yates": "CM", "Schlager": "CDM",
  "Wood": "ST", "Igor Jesus": "ST", "Awoniyi": "ST", "Kalimuendo": "ST",

  // Tottenham
  "Vicario": "GK", "Austin": "GK", "Kinsky": "GK", "Dubravka": "GK",
  "Van Hecke": "LCB", "Romero": "RCB", "Danso": "CB",
  "Robertson": "LB", "Van de Ven": "LCB", "Spence": "RB",
  "Udogie": "LB", "Phillips": "CB", "Davies": "CB",
  "Pedro Porro": "RB", "Senesi": "CB", "Byfield": "CB", "Rowswell": "CB",
  "Souza": "CB",
  "Kudus": "RW", "Xavi": "CAM", "Tel": "ST",
  "Maddison": "CAM", "Bentancur": "CDM", "Odobert": "LW",
  "P.M.Sarr": "CM", "Gallagher": "CM", "Bergvall": "CM",
  "Kulusevski": "RW", "Gray": "CM", "Moore": "LW",
  "Olusesi": "CM", "Fernandes": "CM",
  "Solanke": "ST", "Richarlison": "ST", "Scarlett": "ST",
  "Tonali": "CDM",

  // Sunderland
  "Roefs": "GK", "Patterson": "GK", "Ellborg": "GK",
  "Ballard": "RCB", "Mukiele": "CB", "Hume": "RB",
  "Alderete": "LCB", "Reinildo": "LB", "Seelt": "CB",
  "Hjelde": "LB", "O'Nien": "CB", "Masuaku": "LB", "Meunier": "RB",
  "E.Le Fée": "CM", "Diarra": "CM", "Xhaka": "CDM",
  "Sadiki": "CM", "Adingra": "RW", "Mundle": "LW",
  "Rigg": "CM", "Talbi": "RW", "Angulo": "CM",
  "Brobbey": "ST", "Isidor": "ST"
};

// Position → zone mapping for 4-2-3-1
const ZONE_MAP = {
  "GK": "gk",
  "LB": "lb", "RB": "rb",
  "LCB": "lcb", "RCB": "rcb", "CB": "lcb",
  "CDM": "ldm", "DM": "ldm",
  "CM": "rdm",
  "CAM": "cam",
  "LW": "lw", "RW": "rw",
  "LM": "lw", "RM": "rw",
  "ST": "st", "CF": "st", "SS": "st"
};

const ZONE_GROUP = {
  gk: 'gk',
  lb: 'defence', lcb: 'defence', rcb: 'defence', rb: 'defence',
  ldm: 'midfield', rdm: 'midfield',
  lw: 'attack', cam: 'attack', rw: 'attack', st: 'attack'
};

const POSITION_LABELS = {
  "GK": "GK", "CB": "CB", "LCB": "LCB", "RCB": "RCB",
  "LB": "LB", "RB": "RB",
  "CDM": "CDM", "DM": "CDM",
  "CM": "CM",
  "CAM": "CAM",
  "LW": "LW", "RW": "RW",
  "ST": "ST"
};

const ZONE_LABELS = {
  gk: "GK",
  lb: "LB", lcb: "LCB", rcb: "RCB", rb: "RB",
  ldm: "LDM", rdm: "RDM",
  lw: "LW", cam: "CAM", rw: "RW", st: "ST"
};

const ATTACKING_ZONES = ["lw", "cam", "rw", "st"];
const DEFENSIVE_ZONES = ["lb", "lcb", "rcb", "rb"];
const MIDFIELD_ZONES = ["ldm", "rdm"];
const ALL_ZONES = ["gk", "lb", "lcb", "rcb", "rb", "ldm", "rdm", "lw", "cam", "rw", "st"];

module.exports = { DETAILED_POSITIONS, ZONE_MAP, ZONE_LABELS, ZONE_GROUP, POSITION_LABELS, ATTACKING_ZONES, DEFENSIVE_ZONES, MIDFIELD_ZONES, ALL_ZONES };
