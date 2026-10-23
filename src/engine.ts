/**
 * The cedarengine HTTP API, as an alternative to the Cedarville portal.
 *
 * The portal wants a browser session cookie and can vanish behind SSO
 * mid-search. The engine holds the same directory in one database and answers
 * with a bearer token, which makes it the quieter choice for day-to-day use:
 * no window, no renewal, and it keeps working when the portal is down.
 */

import type { DirectoryPerson, PersonInfo, ScheduleItem } from "./api";

export interface EngineConfig {
  url: string;
  token: string;
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

interface EnginePerson {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  nickname: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  department: string | null;
  title: string | null;
  officeName: string | null;
  officeRoom: string | null;
  officePhone: string | null;
  dormCode: string | null;
  dormName: string | null;
  dormRoom: string | null;
  studentType: string | null;
  studentClass: string | null;
  studentWorker: string | null;
  empInactive: string | null;
  photoUrl: string | null;
}

interface EngineBlock {
  start: string;
  end: string;
  section: string;
  title: string | null;
  kind: string | null;
  building: string | null;
  room: string | null;
}

interface EngineSchedule {
  term: string;
  credits: number | null;
  week: { day: number; label: string; blocks: EngineBlock[] }[];
  online: { name: string; title: string | null; faculty: string | null }[];
}

interface EngineMajor {
  school: { name: string; agreement: number; of: number; unanimous: boolean } | null;
  guesses: { title: string; score: number }[];
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function truthy(value: string | null): boolean | null {
  if (value === null) return null;
  return ["true", "y", "yes"].includes(value.toLowerCase());
}

/** The upstream shape, so the rest of the extension never learns where it came from. */
export function toDirectoryPerson(p: EnginePerson): DirectoryPerson {
  return {
    Id: p.id,
    Username: p.username ?? "",
    FirstName: p.firstName ?? "",
    LastName: p.lastName ?? "",
    MiddleName: clean(p.middleName),
    Nickname: clean(p.nickname),
    AddressCity: clean(p.city),
    AddressState: clean(p.state),
    AddressCountry: clean(p.country),
    DepartmentDescription: clean(p.department),
    Title: clean(p.title),
    OfficeBuildingCode: clean(p.officeName),
    OfficeBuildingName: clean(p.officeName),
    OfficeRoom: clean(p.officeRoom),
    OfficePhone: clean(p.officePhone),
    DormCode: clean(p.dormCode),
    DormName: clean(p.dormName),
    DormRoom: clean(p.dormRoom),
    StudentType: clean(p.studentType),
    StudentClass: clean(p.studentClass),
    studentWorker: truthy(p.studentWorker),
    empInactive: truthy(p.empInactive),
    // Student photos are relative links into the campus portal, which needs a
    // login. Only the absolute ones are worth passing along.
    PhotoUrl: p.photoUrl?.startsWith("http") ? p.photoUrl : null,
  };
}

async function get<T>(
  config: EngineConfig,
  path: string,
  query: Record<string, string> = {},
): Promise<T> {
  if (!config.token) throw new EngineError("Add a cedarengine token in preferences.");
  const url = new URL(path.replace(/^\//, ""), config.url.endsWith("/") ? config.url : `${config.url}/`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new EngineError("The engine refused the token. Check it in preferences.");
  }
  if (res.status === 404) throw new EngineError("Not found.");
  if (!res.ok) throw new EngineError(`The engine answered ${res.status}.`);
  return (await res.json()) as T;
}

async function optional<T>(
  config: EngineConfig,
  path: string,
  query: Record<string, string> = {},
): Promise<T | null> {
  try {
    return await get<T>(config, path, query);
  } catch (err) {
    if (err instanceof EngineError && err.message === "Not found.") return null;
    throw err;
  }
}

export async function searchEngine(
  config: EngineConfig,
  query: string,
  options?: { department?: string },
): Promise<DirectoryPerson[]> {
  const data = await get<{ people: EnginePerson[] }>(config, "v1/people", {
    q: query,
    limit: "100",
    ...(options?.department ? { department: options.department } : {}),
  });
  return data.people.map(toDirectoryPerson);
}

function itemsOf(schedule: EngineSchedule): ScheduleItem[] {
  const items: ScheduleItem[] = [];
  for (const day of schedule.week ?? []) {
    for (const block of day.blocks ?? []) {
      items.push({
        title: block.title ?? block.section,
        description: [block.section, [block.building, block.room].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(" · "),
        startTime: block.start,
        endTime: block.end,
        day: day.label,
        type: block.kind ?? "Lecture",
      });
    }
  }
  return items;
}

const emptyStudent = (term: string): PersonInfo["student"] => ({
  isStudent: false,
  scheduleItems: [],
  programs: [],
  majors: [],
  minors: [],
  concentrations: [],
  advisors: [],
  term: { key: term, description: term },
  nonScheduledCourses: [],
});

/** A page with fields but no schedule, for when the engine cannot be reached. */
export function emptyInfo(): PersonInfo {
  return {
    faculty: { isFaculty: false, facultyDepts: [], scheduleItems: [], term: { key: null, description: null } },
    student: emptyStudent(""),
    person: { box: null },
    address: null,
  };
}

/** Everything the detail screen wants, assembled from the engine's routes. */
export async function personInfo(
  config: EngineConfig,
  person: DirectoryPerson,
): Promise<PersonInfo> {
  const id = person.Id;
  const [schedule, teaching, major] = await Promise.all([
    optional<EngineSchedule>(config, `v1/people/${id}/schedule`),
    optional<EngineSchedule>(config, `v1/people/${id}/teaching`),
    optional<EngineMajor>(config, `v1/people/${id}/major`),
  ]);

  const info: PersonInfo = {
    faculty: {
      isFaculty: false,
      facultyDepts: [],
      scheduleItems: [],
      term: { key: null, description: null },
    },
    student: emptyStudent(schedule?.term ?? teaching?.term ?? ""),
    person: { box: null },
    address: null,
  };

  if (teaching) {
    info.faculty = {
      isFaculty: true,
      facultyDepts: person.DepartmentDescription
        ? [
            {
              code: person.DepartmentDescription,
              description: person.DepartmentDescription,
              division: "",
            },
          ]
        : [],
      scheduleItems: itemsOf(teaching),
      term: { key: teaching.term, description: teaching.term },
    };
  }

  // No teaching and no booklist is most staff; only students get the student half.
  if (!teaching && (schedule || major?.guesses?.length)) {
    info.student = {
      ...emptyStudent(schedule?.term ?? ""),
      isStudent: true,
      scheduleItems: schedule ? itemsOf(schedule) : [],
      // These are the model's guesses, which is why they are labelled as such.
      majors: (major?.guesses ?? []).slice(0, 3).map((guess) => ({
        code: guess.title,
        desc: `${guess.title} (${Math.round(guess.score * 100)}%)`,
      })),
      programs: major?.school ? [{ key: major.school.name, title: major.school.name }] : [],
    };
  }

  return info;
}
