import type { Knex } from 'knex'
import cron from 'node-cron'
import axios from 'axios'
import mailer from 'nodemailer'

import { db } from '~/middleware/database'
import { env } from '~/env.mjs'

const {
  MAILER_HOST,
  MAILER_PORT,
  MAILER_USER,
  MAILER_PASS
} = env

const GITHUB_API = 'https://api.github.com'
const GITHUB_CDN = 'https://raw.githubusercontent.com'

interface WatcherRow {
  crn: number
  emails: string[]
}

interface Section {
  sec: string
  cap: number
  rem: number
  crn: number
}

interface Course {
  crse: string
  id: string
  sections: Section[]
  title: string
}

interface Department {
  code: string
  courses: Course[]
}

const transporter = mailer.createTransport({
  host: MAILER_HOST,
  port: MAILER_PORT,
  auth: {
    user: MAILER_USER,
    pass: MAILER_PASS
  }
})

class Watcher {
  db: Knex
  courseData?: Department[]
  initialized = false

  constructor (db: Knex) {
    this.db = db
  }

  /**
   * Start scan
   */
  async init (): Promise<void> {
    if (!this.initialized) {
      this.initialized = true

      await this.scan()
      this.watch()
    }
  }

  /**
   * Scan for seat updates
   */
  scan (): Promise<void> {
    console.info('Beginning scan...')

    const listenerPromise: Promise<WatcherRow[]> = db('watchers')
      .select(['crn', 'emails'])

    return axios.get(`${GITHUB_API}/repos/quacs/quacs-data/contents/semester_data`)
      .then(({ data: semesters }) => axios.get<Department[]>(`${GITHUB_CDN}/quacs/quacs-data/master/${semesters[semesters.length - 1].path}/courses.json`))
      .then(async ({ data: departments }) => {
        this.courseData = departments

        const listeners = new Map<number, string[]>()
        for (const listener of await listenerPromise) listeners.set(listener.crn, listener.emails)

        for (const department of departments) {
          for (const course of department.courses) {
            for (const section of course.sections) {
              if (listeners.has(section.crn) && section.rem > 0) {
                const recipients = listeners.get(section.crn)?.join(', ') ?? ''

                console.log(`Emailing [${recipients}]`)

                transporter.sendMail({
                  to: recipients,
                  from: {
                    name: 'QuACS Birdwatch',
                    address: MAILER_USER
                  },
                  subject: `Course [${course.title}] section [${section.sec}] has a seat available!`,
                  text: `${section.rem}/${section.cap} seats available`
                }, (err) => {
                  if (err) console.error(err)
                })

                void db('watchers')
                  .delete()
                  .where({
                    crn: section.crn
                  })
                  .then(() => console.log(`Deleted ${section.crn}`))
              }
            }
          }
        }
      })
  }

  /**
   * Register an email to receive updates for a CRN
   * @param crn   The CRN
   * @param email The email
   */
  async register (crn: number, email: string): Promise<void> {
    let found = false

    if (!this.courseData) await this.scan()

    for (const department of this.courseData!) {
      for (const course of department.courses) {
        for (const section of course.sections) {
          if (section.crn === crn) {
            found = true

            break
          }
        }

        if (found) break
      }

      if (found) break
    }

    if (!found) throw Error('not found')

    await db('watchers')
      .insert({
        crn,
        emails: [email]
      })
      .onConflict('crn')
      .merge({
        emails: db.raw('watchers.emails || EXCLUDED.emails')
      })
      .then(() => console.log(`added ${email} to ${crn}`))
  }

  /**
   * Unregister an email from receiving updates
   * @param email The email
   * @param crn   The CRN if only for one section
   */
  purge (email: string, crn?: number): Promise<void> {
    let query = db('watchers')
      .update({
        emails: db.raw('ARRAY_REMOVE(emails, ?)', [email])
      })

    if (crn) {
      query = query.where({
        crn
      })
    }

    return query
      .then((num) => console.log(`removed ${email} from ${crn ?? `${num} CRNs`}`))
  }

  /**
   * Set up a cron job to watch for data updates
   */
  watch (): void {
    cron.schedule('*/30 * * * *', () => void this.scan())
  }
}

export const watcher = new Watcher(db)

void watcher.init()
