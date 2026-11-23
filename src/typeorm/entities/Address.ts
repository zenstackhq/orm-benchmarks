// src/entity/Address.ts
import "reflect-metadata";

import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, type Relation } from "typeorm";
import { Customer } from "./Customer";

@Entity("Address")
export class Address {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  street: string;

  @Column()
  city: string;

  @Column({ name: "postalCode" })
  postalCode: string;

  @Column()
  country: string;

  @ManyToOne(() => Customer, (customer) => customer.addresses, { onDelete: "CASCADE", onUpdate: "CASCADE" })
  // Relation<> keeps the decorator metadata from reading Customer before it exists (circular import).
  customer: Relation<Customer>;
}
